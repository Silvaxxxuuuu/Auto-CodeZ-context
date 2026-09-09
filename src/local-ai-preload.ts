import { contextBridge, ipcRenderer } from 'electron';
import { requireIdentifier, requireObject } from './core/input-validation';

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

contextBridge.exposeInMainWorld('autoCodezLocalAi', {
  snapshot: () => invoke('local-ai:snapshot'),
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
