import crypto from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { LocalStorage } from '../core/storage';
import { PluginService } from './plugin-service';
import { PluginSettingsStore } from './plugin-settings-store';
import { PluginStateStore } from './plugin-state-store';
import { PluginSandboxCallRouter } from './plugin-sandbox-call-router';
import { pluginToolCatalog, type PluginToolExecutionContext } from './plugin-tool-catalog';
import type { PluginCapabilityRequest, PluginCapabilityResponse } from './plugin-capability-broker';
import type { PluginPermission } from './plugin-types';
import { operationalLedger } from '../operational-ledger';

type ActivePluginInvocation = {
  invocationId: string;
  pluginId: string;
  toolId: string;
  context: PluginToolExecutionContext;
};

let servicePromise: Promise<PluginService> | undefined;
const sandboxCalls = new PluginSandboxCallRouter();
const activePluginInvocations = new Map<string, ActivePluginInvocation>();
const capabilityInvocationStorage = new AsyncLocalStorage<ActivePluginInvocation>();

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
  if (record.invocationId !== undefined && (typeof record.invocationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(record.invocationId))) {
    throw new Error('ID da invocação do plugin inválido.');
  }
  return {
    id: record.id,
    method: record.method,
    ...(Object.prototype.hasOwnProperty.call(record, 'input') ? { input: record.input } : {}),
    ...(typeof record.invocationId === 'string' ? { invocationId: record.invocationId } : {}),
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
  const builtInPluginsRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'plugins')
    : path.join(app.getAppPath(), 'plugins');
  const settings = new PluginSettingsStore(storage);
  const service = new PluginService(pluginsRoot, new PluginStateStore(storage), settings, builtInPluginsRoot);
  await service.init();
  const broker = service.getBroker();
  broker.getActivityRuntime().subscribe((activity) => {
    broadcast('plugins:activity', activity);
    const invocation = capabilityInvocationStorage.getStore();
    operationalLedger.record({
      actor: 'plugin',
      category: 'plugin',
      state: activity.status === 'completed' ? 'success' : activity.status === 'failed' ? 'failed' : activity.status === 'waiting' ? 'waiting' : 'running',
      summary: activity.message,
      pluginId: activity.pluginId,
      ...(invocation ? {
        chatId: invocation.context.chatId,
        runId: invocation.context.runId,
        projectId: invocation.context.projectId,
        toolCallId: invocation.context.toolCallId,
        causationId: invocation.invocationId,
      } : {}),
      timestamp: activity.updatedAt,
    });
  });

  broker.getJobRuntime().subscribe((job) => {
    broadcast('plugins:job', job);
    const invocation = capabilityInvocationStorage.getStore();
    operationalLedger.record({
      actor: 'plugin',
      category: 'job',
      state: job.state === 'completed' ? 'success' : job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' : 'running',
      summary: job.activity || job.label,
      pluginId: job.pluginId,
      jobId: job.id,
      artifactIds: job.artifactIds,
      progress: job.progress,
      error: job.error,
      ...(invocation ? {
        chatId: invocation.context.chatId,
        runId: invocation.context.runId,
        projectId: invocation.context.projectId,
        toolCallId: invocation.context.toolCallId,
        causationId: invocation.invocationId,
      } : {}),
      timestamp: job.updatedAt,
    });
  });

  broker.getArtifactRuntime().subscribe((artifact) => {
    const invocation = capabilityInvocationStorage.getStore();
    operationalLedger.record({
      actor: 'plugin',
      category: 'artifact',
      state: 'success',
      summary: `Artifact ${artifact.kind} produzido.`,
      pluginId: artifact.pluginId,
      artifactIds: [artifact.id],
      ...(invocation ? {
        chatId: invocation.context.chatId,
        runId: invocation.context.runId,
        projectId: invocation.context.projectId,
        toolCallId: invocation.context.toolCallId,
        causationId: invocation.invocationId,
      } : {}),
      details: {
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
      },
      timestamp: artifact.createdAt,
    });
  });

  pluginToolCatalog.configureExecutor(async (pluginId, toolId, input, context) => {
    if (!service.hasPermission(pluginId, 'ai:tool')) throw new Error(`Plugin '${pluginId}' perdeu a permissão ai:tool.`);
    const startedAt = Date.now();
    const invocationId = crypto.randomUUID();
    const invocation: ActivePluginInvocation = { invocationId, pluginId, toolId, context: { ...context } };
    operationalLedger.record({
      actor: 'plugin',
      category: 'tool',
      state: 'running',
      summary: `Executando tool do plugin: ${toolId}.`,
      pluginId,
      toolName: toolId,
      chatId: context.chatId,
      runId: context.runId,
      projectId: context.projectId,
      toolCallId: context.toolCallId,
      causationId: invocationId,
      timestamp: startedAt,
    });
    activePluginInvocations.set(invocationId, invocation);
    try {
      const value = await sandboxCalls.call(pluginId, toolId, { input, context }, invocationId);
      operationalLedger.record({
        actor: 'plugin',
        category: 'tool',
        state: 'success',
        summary: `Tool do plugin concluída: ${toolId}.`,
        pluginId,
        toolName: toolId,
        chatId: context.chatId,
        runId: context.runId,
        projectId: context.projectId,
        toolCallId: context.toolCallId,
        causationId: invocationId,
        durationMs: Date.now() - startedAt,
      });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      operationalLedger.record({
        actor: 'plugin',
        category: 'tool',
        state: 'failed',
        summary: `Tool do plugin falhou: ${toolId}.`,
        pluginId,
        toolName: toolId,
        chatId: context.chatId,
        runId: context.runId,
        projectId: context.projectId,
        toolCallId: context.toolCallId,
        causationId: invocationId,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw error;
    } finally {
      activePluginInvocations.delete(invocationId);
    }
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
ipcMain.handle('plugins:public-status', async (_event, pluginId: unknown) => (await pluginService()).publicStatus(requirePluginId(pluginId)));
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
  const id = requirePluginId(pluginId);
  const capability = requireCapabilityRequest(request);
  if (!capability.invocationId) return (await pluginService()).invoke(id, capability);
  const invocation = activePluginInvocations.get(capability.invocationId);
  if (!invocation || invocation.pluginId !== id) {
    return { id: capability.id, ok: false, error: 'Invocação do plugin não está mais ativa ou não pertence a este plugin.' };
  }
  return capabilityInvocationStorage.run(invocation, async () => (await pluginService()).invoke(id, capability));
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
