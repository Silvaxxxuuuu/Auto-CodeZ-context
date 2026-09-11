import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('autoCodezPlugins', {
  snapshot: () => ipcRenderer.invoke('plugins:snapshot'),
  refresh: () => ipcRenderer.invoke('plugins:refresh'),
  installFromFolder: () => ipcRenderer.invoke('plugins:install-folder'),
  uninstall: (pluginId: string) => ipcRenderer.invoke('plugins:uninstall', pluginId),
  grant: (pluginId: string, permissions: string[]) => ipcRenderer.invoke('plugins:grant', pluginId, permissions),
  enable: (pluginId: string) => ipcRenderer.invoke('plugins:enable', pluginId),
  disable: (pluginId: string) => ipcRenderer.invoke('plugins:disable', pluginId),
  revoke: (pluginId: string, permission: string) => ipcRenderer.invoke('plugins:revoke', pluginId, permission),
  source: (pluginId: string) => ipcRenderer.invoke('plugins:source', pluginId),
  invoke: (pluginId: string, request: { id: string; method: string; input?: unknown }) => ipcRenderer.invoke('plugins:invoke', pluginId, request),
  markHealthy: (pluginId: string, message?: string) => ipcRenderer.invoke('plugins:healthy', pluginId, message),
  markFailed: (pluginId: string, reason: string) => ipcRenderer.invoke('plugins:failed', pluginId, reason),
  respondSandboxCall: (result: { id: string; value?: unknown; error?: string }) => ipcRenderer.invoke('plugins:sandbox-call-result', result),
  onSandboxCall: (listener: (call: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, call: unknown) => listener(call);
    ipcRenderer.on('plugins:sandbox-call', wrapped);
    return () => ipcRenderer.removeListener('plugins:sandbox-call', wrapped);
  },
  onActivity: (listener: (activity: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, activity: unknown) => listener(activity);
    ipcRenderer.on('plugins:activity', wrapped);
    return () => ipcRenderer.removeListener('plugins:activity', wrapped);
  },
  onJob: (listener: (job: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, job: unknown) => listener(job);
    ipcRenderer.on('plugins:job', wrapped);
    return () => ipcRenderer.removeListener('plugins:job', wrapped);
  },
});

void ipcRenderer.invoke('plugins:renderer-ready').catch((): undefined => undefined);
