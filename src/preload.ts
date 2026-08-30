import { contextBridge, ipcRenderer } from 'electron';

function reportRendererError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || 'Operação falhou.');
  window.alert(`Auto CodeZ\n\n${message}`);
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T;
  } catch (error) {
    reportRendererError(error);
    throw error;
  }
}

contextBridge.exposeInMainWorld('autoCodez', {
  getState: () => invoke<{ providers: unknown[]; chats: unknown[]; projects: unknown[] }>('app:get-state'),
  listModels: (providerId: string) => invoke('providers:list-models', providerId),
  saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => invoke('providers:save', input),
  removeProvider: (providerId: string) => invoke('providers:remove', providerId),
  createChat: (input: { providerId: string; model: string; intelligence: string; permissionLevel: string; projectId?: string }) => invoke('chat:create', input),
  updateChatSettings: (input: { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }) => invoke('chat:update-settings', input),
  sendChat: (input: { chatId: string; content: string }) => invoke('chat:send', input),
  streamChat: (input: { chatId: string; content: string }) => invoke('chat:stream', input),
  onStreamEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('chat:stream-event', handler);
    return () => ipcRenderer.removeListener('chat:stream-event', handler);
  },
  listTools: () => invoke('agent:list-tools'),
  listApprovals: () => invoke('agent:list-approvals'),
  approveTool: (approvalId: string) => invoke('agent:approve', approvalId),
  denyTool: (approvalId: string) => invoke('agent:deny', approvalId),
  onActivity: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('agent:activity', handler);
    return () => ipcRenderer.removeListener('agent:activity', handler);
  },
  createProject: (input: { name: string; rootPath: string }) => invoke('projects:create', input),
  openFolder: () => invoke('projects:open-folder'),
  scanProject: (rootPath: string) => invoke('projects:scan', rootPath),
  readFile: (filePath: string) => invoke('projects:read-file', filePath),
  writeFile: (input: { filePath: string; content: string }) => invoke('projects:write-file', input),
  openExternal: (url: string) => invoke('app:open-external', url),
});
