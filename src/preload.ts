import { contextBridge, ipcRenderer } from 'electron';

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Operação falhou.';
}

function reportRendererError(error: unknown): void {
  window.alert(`Auto CodeZ\n\n${normalizeError(error)}`);
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
  saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => {
    if (!input.providerId) {
      const error = new Error('Selecione uma IA antes de continuar.');
      reportRendererError(error);
      return Promise.reject(error);
    }
    if (!input.apiKey.trim()) {
      const error = new Error('Informe a API key antes de testar e salvar.');
      reportRendererError(error);
      return Promise.reject(error);
    }
    return invoke('providers:save', { ...input, apiKey: input.apiKey.trim() });
  },
  removeProvider: (providerId: string) => invoke('providers:remove', providerId),
  createChat: (input: { providerId: string; model: string; intelligence: string; permissionLevel: string; projectId?: string }) => {
    if (!input.providerId || !input.model) {
      const error = new Error('Configure uma IA e selecione um modelo antes de criar o chat.');
      reportRendererError(error);
      return Promise.reject(error);
    }
    return invoke('chat:create', input);
  },
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
  createProject: (input: { name: string; rootPath: string }) => {
    if (!input.name.trim()) {
      const error = new Error('Informe um nome para o projeto.');
      reportRendererError(error);
      return Promise.reject(error);
    }
    if (!input.rootPath.trim()) {
      const error = new Error('Selecione uma pasta para o projeto.');
      reportRendererError(error);
      return Promise.reject(error);
    }
    return invoke('projects:create', { ...input, name: input.name.trim(), rootPath: input.rootPath.trim() });
  },
  openFolder: () => invoke<string | null>('projects:open-folder'),
  scanProject: (rootPath: string) => invoke('projects:scan', rootPath),
  readFile: (filePath: string) => invoke('projects:read-file', filePath),
  writeFile: (input: { filePath: string; content: string }) => invoke('projects:write-file', input),
  openExternal: (url: string) => invoke('app:open-external', url),
});