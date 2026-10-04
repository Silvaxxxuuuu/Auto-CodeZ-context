import { contextBridge, ipcRenderer } from 'electron';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return await ipcRenderer.invoke(channel, ...args) as T;
}

function requireModelOperation(input: unknown, label: string): { runtimeId: string; modelId: string } {
  const value = requireObject(input, label);
  return {
    runtimeId: requireIdentifier(value.runtimeId, 'Runtime local'),
    modelId: requireIdentifier(value.modelId, 'Modelo local'),
  };
}

function requireRuntimeSettings(input: unknown): { runtimeId: string; endpoint: string; apiToken?: string; clearToken?: boolean } {
  const value = requireObject(input, 'Configuração do runtime local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const endpoint = requireNonEmptyString(value.endpoint, 'Endpoint local');
  if (value.apiToken !== undefined && typeof value.apiToken !== 'string') throw new Error('Token local inválido.');
  if (value.clearToken !== undefined && typeof value.clearToken !== 'boolean') throw new Error('Opção de limpeza do token local inválida.');
  const apiToken = typeof value.apiToken === 'string' && value.apiToken.trim() ? value.apiToken : undefined;
  return {
    runtimeId,
    endpoint,
    ...(apiToken ? { apiToken } : {}),
    ...(value.clearToken === true ? { clearToken: true } : {}),
  };
}

contextBridge.exposeInMainWorld('autoCodezLocalAi', {
  snapshot: () => invoke('local-ai:snapshot'),
  listSettings: () => invoke('local-ai:list-settings'),
  saveSettings: (input: { runtimeId: string; endpoint: string; apiToken?: string; clearToken?: boolean }) => invoke('local-ai:save-settings', requireRuntimeSettings(input)),
  install: (input: { runtimeId: string; modelId: string }) => invoke('local-ai:install', requireModelOperation(input, 'Instalação de modelo local')),
  cancelInstall: (input: { runtimeId: string; modelId: string }) => invoke('local-ai:cancel-install', requireModelOperation(input, 'Cancelamento de instalação local')),
  remove: (input: { runtimeId: string; modelId: string }) => invoke('local-ai:remove', requireModelOperation(input, 'Remoção de modelo local')),
  onInstallEvent: (listener: (event: unknown) => void) => {
    if (typeof listener !== 'function') throw new Error('Listener de instalação local inválido.');
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('local-ai:install-event', handler);
    return () => ipcRenderer.removeListener('local-ai:install-event', handler);
  },
});
