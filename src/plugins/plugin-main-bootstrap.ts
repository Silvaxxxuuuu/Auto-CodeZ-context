import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { LocalStorage } from '../core/storage';
import { PluginService } from './plugin-service';
import { PluginSettingsStore } from './plugin-settings-store';
import { PluginStateStore } from './plugin-state-store';
import { PluginSandboxCallRouter } from './plugin-sandbox-call-router';
import { pluginToolCatalog } from './plugin-tool-catalog';
import type { PluginCapabilityRequest, PluginCapabilityResponse } from './plugin-capability-broker';
import type { PluginPermission } from './plugin-types';

let servicePromise: Promise<PluginService> | undefined;
const sandboxCalls = new PluginSandboxCallRouter();

function requirePluginId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(value)) {
    throw new Error('ID de plugin inválido.');
  }
  return value;
}

function requirePermissionList(value: unknown): PluginPermission[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('Lista de permissões inválida.');
  return [...new Set(value as PluginPermission[])];
}

function requireCapabilityRequest(value: unknown): PluginCapabilityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Solicitação de capability inválida.');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.method !== 'string') throw new Error('Solicitação de capability inválida.');
  return {
    id: record.id,
    method: record.method,
    ...(Object.prototype.hasOwnProperty.call(record, 'input') ? { input: record.input } : {}),
  };
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

async function createPluginService(): Promise<PluginService> {
  const storage = new LocalStorage();
  await storage.init();
  const pluginsRoot = path.join(app.getPath('userData'), 'plugins');
  const settings = new PluginSettingsStore(storage);
  const service = new PluginService(pluginsRoot, new PluginStateStore(storage), settings);
  await service.init();
  const broker = service.getBroker();
  broker.getActivityRuntime().subscribe((activity) => broadcast('plugins:activity', activity));
  broker.getJobRuntime().subscribe((job) => broadcast('plugins:job', job));
  pluginToolCatalog.configureExecutor(async (pluginId, toolId, input, context) => {
    if (!service.hasPermission(pluginId, 'ai:tool')) throw new Error(`Plugin '${pluginId}' perdeu a permissão ai:tool.`);
    return sandboxCalls.call(pluginId, toolId, { input, context });
  });
  return service;
}

function pluginService(): Promise<PluginService> {
  if (!servicePromise) servicePromise = app.whenReady().then(createPluginService);
  return servicePromise;
}

ipcMain.handle('plugins:renderer-ready', (event) => {
  sandboxCalls.bind(event.sender);
  return true;
});
ipcMain.handle('plugins:snapshot', async () => (await pluginService()).snapshot());
ipcMain.handle('plugins:refresh', async () => {
  sandboxCalls.cancelAll('Plugins foram recarregados.');
  return (await pluginService()).refresh();
});
ipcMain.handle('plugins:install-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Instalar plugin do Auto CodeZ',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  sandboxCalls.cancelAll('Pacotes de plugins foram atualizados.');
  return (await pluginService()).install(result.filePaths[0]);
});
ipcMain.handle('plugins:uninstall', async (_event, pluginId: unknown) => {
  const id = requirePluginId(pluginId);
  sandboxCalls.cancelPlugin(id, 'Plugin foi removido durante a execução.');
  return (await pluginService()).uninstall(id);
});
ipcMain.handle('plugins:grant', async (_event, pluginId: unknown, permissions: unknown) => {
  const id = requirePluginId(pluginId);
  const updated = await (await pluginService()).grant(id, requirePermissionList(permissions));
  if (updated.state !== 'enabled') sandboxCalls.cancelPlugin(id, 'Permissões do plugin foram alteradas durante a execução.');
  return updated;
});
ipcMain.handle('plugins:enable', async (_event, pluginId: unknown) => (await pluginService()).enable(requirePluginId(pluginId)));
ipcMain.handle('plugins:disable', async (_event, pluginId: unknown) => {
  const id = requirePluginId(pluginId);
  sandboxCalls.cancelPlugin(id);
  return (await pluginService()).disable(id);
});
ipcMain.handle('plugins:revoke', async (_event, pluginId: unknown, permission: unknown) => {
  if (typeof permission !== 'string') throw new Error('Permissão inválida.');
  const id = requirePluginId(pluginId);
  sandboxCalls.cancelPlugin(id, 'Permissão do plugin foi revogada durante a execução.');
  return (await pluginService()).revoke(id, permission as PluginPermission);
});
ipcMain.handle('plugins:source', async (_event, pluginId: unknown) => (await pluginService()).readMainSource(requirePluginId(pluginId)));
ipcMain.handle('plugins:invoke', async (_event, pluginId: unknown, request: unknown): Promise<PluginCapabilityResponse> => {
  return (await pluginService()).invoke(requirePluginId(pluginId), requireCapabilityRequest(request));
});
ipcMain.handle('plugins:healthy', async (_event, pluginId: unknown, message: unknown) => {
  const normalized = typeof message === 'string' ? message.slice(0, 512) : undefined;
  return (await pluginService()).markHealthy(requirePluginId(pluginId), normalized);
});
ipcMain.handle('plugins:failed', async (_event, pluginId: unknown, reason: unknown) => {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Motivo de falha inválido.');
  const id = requirePluginId(pluginId);
  sandboxCalls.cancelPlugin(id, 'Plugin falhou durante a execução.');
  return (await pluginService()).markFailed(id, reason);
});
ipcMain.handle('plugins:sandbox-call-result', async (event, result: unknown) => sandboxCalls.resolve(event, result));

app.on('before-quit', () => sandboxCalls.cancelAll('Auto CodeZ está encerrando.'));

void pluginService().catch((error) => {
  console.error('Plugin Platform initialization failed:', error);
});
