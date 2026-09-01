import { contextBridge, ipcRenderer } from 'electron';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';

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
  listModels: (providerId: string) => invoke('providers:list-models', requireIdentifier(providerId, 'Provider')),
  saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => {
    const value = requireObject(input, 'Dados do provider');
    const providerId = requireIdentifier(value.providerId, 'Provider');
    const apiKey = requireNonEmptyString(value.apiKey, 'API key');
    const model = value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo');
    const baseUrl = value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base');
    return invoke('providers:save', { providerId, apiKey, model, baseUrl });
  },
  removeProvider: (providerId: string) => invoke('providers:remove', requireIdentifier(providerId, 'Provider')),
  createChat: (input: { providerId?: string; model?: string; intelligence: string; permissionLevel: string; projectId?: string }) => {
    const value = requireObject(input, 'Dados do chat');
    const providerId = value.providerId === undefined ? undefined : requireIdentifier(value.providerId, 'Provider');
    const model = value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo');
    const intelligence = requireIdentifier(value.intelligence, 'Inteligência');
    const permissionLevel = requireIdentifier(value.permissionLevel, 'Permissão');
    const projectId = value.projectId === undefined ? undefined : requireIdentifier(value.projectId, 'Projeto');
    return invoke('chat:create', { providerId, model, intelligence, permissionLevel, projectId });
  },
  deleteChat: (chatId: string) => invoke('chat:delete', requireIdentifier(chatId, 'Chat')),
  updateChatSettings: (input: { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }) => {
    const value = requireObject(input, 'Configurações do chat');
    return invoke('chat:update-settings', {
      chatId: requireIdentifier(value.chatId, 'Chat'),
      providerId: requireIdentifier(value.providerId, 'Provider'),
      model: requireIdentifier(value.model, 'Modelo'),
      intelligence: requireIdentifier(value.intelligence, 'Inteligência'),
      permissionLevel: requireIdentifier(value.permissionLevel, 'Permissão'),
    });
  },
  sendChat: (input: { chatId: string; content: string }) => {
    const value = requireObject(input, 'Mensagem');
    return invoke('chat:send', {
      chatId: requireIdentifier(value.chatId, 'Chat'),
      content: requireNonEmptyString(value.content, 'Mensagem'),
    });
  },
  streamChat: (input: { chatId: string; content: string }) => {
    const value = requireObject(input, 'Mensagem');
    return invoke('chat:stream', {
      chatId: requireIdentifier(value.chatId, 'Chat'),
      content: requireNonEmptyString(value.content, 'Mensagem'),
    });
  },
  onStreamEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('chat:stream-event', handler);
    return () => ipcRenderer.removeListener('chat:stream-event', handler);
  },
  listTools: () => invoke('agent:list-tools'),
  listApprovals: () => invoke('agent:list-approvals'),
  listInterruptedProviderRequests: () => invoke('agent:list-interrupted-provider-requests'),
  approveTool: (approvalId: string) => invoke('agent:approve', requireIdentifier(approvalId, 'Aprovação')),
  denyTool: (approvalId: string) => invoke('agent:deny', requireIdentifier(approvalId, 'Aprovação')),
  onActivity: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('agent:activity', handler);
    return () => ipcRenderer.removeListener('agent:activity', handler);
  },
  terminal: {
    start: (input: { projectId: string; command: string }) => {
      const value = requireObject(input, 'Dados do terminal');
      return invoke('terminal:start', {
        projectId: requireIdentifier(value.projectId, 'Projeto'),
        command: requireNonEmptyString(value.command, 'Comando'),
      });
    },
    kill: (sessionId: string) => invoke('terminal:kill', requireIdentifier(sessionId, 'Sessão do terminal')),
    listSessions: () => invoke('terminal:list-sessions'),
    getOutput: (sessionId: string) => invoke('terminal:get-output', requireIdentifier(sessionId, 'Sessão do terminal')),
    listHistory: (projectId?: string) => invoke('terminal:list-history', projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')),
    clearHistory: (projectId?: string) => invoke('terminal:clear-history', projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')),
    onEvent: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on('terminal:event', handler);
      return () => ipcRenderer.removeListener('terminal:event', handler);
    },
  },
  git: {
    status: (projectId: string) => invoke('git:status', requireIdentifier(projectId, 'Projeto')),
    branches: (projectId: string) => invoke('git:branches', requireIdentifier(projectId, 'Projeto')),
    diff: (projectId: string) => invoke('git:diff', requireIdentifier(projectId, 'Projeto')),
    log: (input: { projectId: string; limit?: number }) => {
      const value = requireObject(input, 'Dados do histórico Git');
      const projectId = requireIdentifier(value.projectId, 'Projeto');
      const limit = value.limit === undefined ? undefined : Number(value.limit);
      if (limit !== undefined && !Number.isFinite(limit)) throw new Error('Limite do histórico Git inválido.');
      return invoke('git:log', { projectId, limit });
    },
    createBranch: (input: { projectId: string; name: string }) => {
      const value = requireObject(input, 'Dados da branch');
      return invoke('git:create-branch', {
        projectId: requireIdentifier(value.projectId, 'Projeto'),
        name: requireNonEmptyString(value.name, 'Nome da branch'),
      });
    },
    checkout: (input: { projectId: string; name: string }) => {
      const value = requireObject(input, 'Dados do checkout');
      return invoke('git:checkout', {
        projectId: requireIdentifier(value.projectId, 'Projeto'),
        name: requireNonEmptyString(value.name, 'Branch'),
      });
    },
    stage: (input: { projectId: string; paths: string[] }) => {
      const value = requireObject(input, 'Dados do staging');
      if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== 'string')) throw new Error('Arquivos do staging inválidos.');
      return invoke('git:stage', { projectId: requireIdentifier(value.projectId, 'Projeto'), paths: value.paths.map((item) => requireNonEmptyString(item, 'Arquivo')) });
    },
    stageAll: (projectId: string) => invoke('git:stage-all', requireIdentifier(projectId, 'Projeto')),
    commit: (input: { projectId: string; message: string }) => {
      const value = requireObject(input, 'Dados do commit');
      return invoke('git:commit', {
        projectId: requireIdentifier(value.projectId, 'Projeto'),
        message: requireNonEmptyString(value.message, 'Mensagem do commit'),
      });
    },
  },
  createProject: (input: { name: string; rootPath: string }) => {
    const value = requireObject(input, 'Dados do projeto');
    return invoke('projects:create', {
      name: requireNonEmptyString(value.name, 'Nome do projeto'),
      rootPath: requireNonEmptyString(value.rootPath, 'Pasta do projeto'),
    });
  },
  openFolder: () => invoke<string | null>('projects:open-folder'),
  scanProject: (rootPath: string) => invoke('projects:scan', requireNonEmptyString(rootPath, 'Pasta do projeto')),
  readFile: (filePath: string) => invoke('projects:read-file', requireNonEmptyString(filePath, 'Arquivo')),
  writeFile: (input: { filePath: string; content: string }) => {
    const value = requireObject(input, 'Dados do arquivo');
    return invoke('projects:write-file', {
      filePath: requireNonEmptyString(value.filePath, 'Arquivo'),
      content: typeof value.content === 'string' ? value.content : (() => { throw new Error('Conteúdo do arquivo é inválido.'); })(),
    });
  },
  openExternal: (url: string) => invoke('app:open-external', requireNonEmptyString(url, 'URL externa')),
});