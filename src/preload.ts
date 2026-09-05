import { contextBridge, ipcRenderer } from 'electron';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return await ipcRenderer.invoke(channel, ...args) as T;
}

type ApprovalScope = { chatId?: string; runId?: string };

function requireApprovalScope(input: ApprovalScope | undefined): ApprovalScope | undefined {
  if (input === undefined) return undefined;
  const value = requireObject(input, 'Contexto da aprovação');
  return {
    chatId: value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat'),
    runId: value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução'),
  };
}

function requireTerminalDimension(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} do terminal inválido.`);
  return number;
}

contextBridge.exposeInMainWorld('autoCodez', {
  getState: () => invoke<{ providers: unknown[]; chats: unknown[]; projects: unknown[] }>('app:get-state'),
  listModels: (providerId: string) => invoke('providers:list-models', requireIdentifier(providerId, 'Provider')),
  listModelsForApiKey: (keyId: string) => invoke('providers:list-models-for-key', requireIdentifier(keyId, 'API key')),
  listApiKeys: () => invoke('providers:list-keys'),
  saveApiKey: (input: { providerId: string; name: string; apiKey: string; model?: string; baseUrl?: string }) => {
    const value = requireObject(input, 'Dados da API key');
    return invoke('providers:save-key', {
      providerId: requireIdentifier(value.providerId, 'Provider'),
      name: requireNonEmptyString(value.name, 'Nome da API key'),
      apiKey: requireNonEmptyString(value.apiKey, 'API key'),
      model: value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo'),
      baseUrl: value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base'),
    });
  },
  renameApiKey: (input: { keyId: string; name: string }) => {
    const value = requireObject(input, 'Dados do nome da API key');
    return invoke('providers:rename-key', { keyId: requireIdentifier(value.keyId, 'API key'), name: requireNonEmptyString(value.name, 'Nome da API key') });
  },
  setActiveApiKey: (keyId: string) => invoke('providers:set-active-key', requireIdentifier(keyId, 'API key')),
  removeApiKey: (keyId: string) => invoke('providers:remove-key', requireIdentifier(keyId, 'API key')),
  saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => {
    const value = requireObject(input, 'Dados do provider');
    const providerId = requireIdentifier(value.providerId, 'Provider');
    const apiKey = requireNonEmptyString(value.apiKey, 'API key');
    const model = value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo');
    const baseUrl = value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base');
    return invoke('providers:save', { providerId, apiKey, model, baseUrl });
  },
  removeProvider: (providerId: string) => invoke('providers:remove', requireIdentifier(providerId, 'Provider')),
  createChat: (input: { providerId?: string; model?: string; apiKeyId?: string; intelligence: string; permissionLevel: string; projectId?: string }) => {
    const value = requireObject(input, 'Dados do chat');
    const providerId = value.providerId === undefined ? undefined : requireIdentifier(value.providerId, 'Provider');
    const model = value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo');
    const apiKeyId = value.apiKeyId === undefined ? undefined : requireIdentifier(value.apiKeyId, 'API key');
    const intelligence = requireIdentifier(value.intelligence, 'Inteligência');
    const permissionLevel = requireIdentifier(value.permissionLevel, 'Permissão');
    const projectId = value.projectId === undefined ? undefined : requireIdentifier(value.projectId, 'Projeto');
    return invoke('chat:create', { providerId, model, apiKeyId, intelligence, permissionLevel, projectId });
  },
  deleteChat: (chatId: string) => invoke('chat:delete', requireIdentifier(chatId, 'Chat')),
  renameChat: (input: { chatId: string; title: string }) => {
    const value = requireObject(input, 'Dados do nome do chat');
    return invoke('chat:rename', { chatId: requireIdentifier(value.chatId, 'Chat'), title: requireNonEmptyString(value.title, 'Nome do chat') });
  },
  updateChatSettings: (input: { chatId: string; providerId: string; model: string; apiKeyId?: string; intelligence: string; permissionLevel: string }) => {
    const value = requireObject(input, 'Configurações do chat');
    return invoke('chat:update-settings', {
      chatId: requireIdentifier(value.chatId, 'Chat'),
      providerId: requireIdentifier(value.providerId, 'Provider'),
      model: requireIdentifier(value.model, 'Modelo'),
      apiKeyId: value.apiKeyId === undefined ? undefined : requireIdentifier(value.apiKeyId, 'API key'),
      intelligence: requireIdentifier(value.intelligence, 'Inteligência'),
      permissionLevel: requireIdentifier(value.permissionLevel, 'Permissão'),
    });
  },
  sendChat: (input: { chatId: string; content: string }) => {
    const value = requireObject(input, 'Mensagem');
    return invoke('chat:send', { chatId: requireIdentifier(value.chatId, 'Chat'), content: requireNonEmptyString(value.content, 'Mensagem') });
  },
  streamChat: async (input: { chatId: string; content: string }) => {
    const value = requireObject(input, 'Mensagem');
    const result = await invoke<{ pendingApprovalIds: string[]; chat: unknown; error?: string }>('chat:stream', { chatId: requireIdentifier(value.chatId, 'Chat'), content: requireNonEmptyString(value.content, 'Mensagem') });
    if (result.error) throw new Error(result.error);
    return result;
  },
  stopChat: (chatId: string) => invoke('chat:stop', requireIdentifier(chatId, 'Chat')),
  onStreamEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('chat:stream-event', handler);
    return () => ipcRenderer.removeListener('chat:stream-event', handler);
  },
  listTools: () => invoke('agent:list-tools'),
  listApprovals: (filters?: ApprovalScope) => invoke('agent:list-approvals', requireApprovalScope(filters)),
  listExecutions: (chatId?: string) => invoke('agent:list-executions', chatId === undefined ? undefined : requireIdentifier(chatId, 'Chat')),
  onExecutionEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('execution:event', handler);
    return () => ipcRenderer.removeListener('execution:event', handler);
  },
  listRecoverableRuns: () => invoke('agent:list-recoverable-runs'),
  resumeRecoveredRun: (runId: string) => invoke('agent:resume-recovered', requireIdentifier(runId, 'Execução recuperável')),
  listInterruptedProviderRequests: () => invoke('agent:list-interrupted-provider-requests'),
  approveTool: (approvalId: string, filters?: ApprovalScope) => invoke('agent:approve', { approvalId: requireIdentifier(approvalId, 'Aprovação'), ...requireApprovalScope(filters) }),
  denyTool: (approvalId: string, filters?: ApprovalScope) => invoke('agent:deny', { approvalId: requireIdentifier(approvalId, 'Aprovação'), ...requireApprovalScope(filters) }),
  onActivity: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('agent:activity', handler);
    return () => ipcRenderer.removeListener('agent:activity', handler);
  },
  terminal: {
    start: (input: { projectId: string; command: string }) => {
      const value = requireObject(input, 'Dados do terminal');
      return invoke('terminal:start', { projectId: requireIdentifier(value.projectId, 'Projeto'), command: requireNonEmptyString(value.command, 'Comando') });
    },
    writeInput: (input: { sessionId: string; data: string }) => {
      const value = requireObject(input, 'Entrada do terminal');
      if (typeof value.data !== 'string') throw new Error('Entrada do terminal inválida.');
      return invoke('terminal:write-input', { sessionId: requireIdentifier(value.sessionId, 'Sessão do terminal'), data: value.data });
    },
    resize: (input: { sessionId: string; cols: number; rows: number }) => {
      const value = requireObject(input, 'Tamanho do terminal');
      return invoke('terminal:resize', {
        sessionId: requireIdentifier(value.sessionId, 'Sessão do terminal'),
        cols: requireTerminalDimension(value.cols, 'Número de colunas'),
        rows: requireTerminalDimension(value.rows, 'Número de linhas'),
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
      return invoke('git:create-branch', { projectId: requireIdentifier(value.projectId, 'Projeto'), name: requireNonEmptyString(value.name, 'Nome da branch') });
    },
    checkout: (input: { projectId: string; name: string }) => {
      const value = requireObject(input, 'Dados do checkout');
      return invoke('git:checkout', { projectId: requireIdentifier(value.projectId, 'Projeto'), name: requireNonEmptyString(value.name, 'Nome da branch') });
    },
    stage: (input: { projectId: string; paths: string[] }) => {
      const value = requireObject(input, 'Dados do staging');
      if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== 'string')) throw new Error('Arquivos do staging inválidos.');
      return invoke('git:stage', { projectId: requireIdentifier(value.projectId, 'Projeto'), paths: value.paths.map((item) => requireNonEmptyString(item, 'Arquivo')) });
    },
    stageAll: (projectId: string) => invoke('git:stage-all', requireIdentifier(projectId, 'Projeto')),
    commit: (input: { projectId: string; message: string }) => {
      const value = requireObject(input, 'Dados do commit');
      return invoke('git:commit', { projectId: requireIdentifier(value.projectId, 'Projeto'), message: requireNonEmptyString(value.message, 'Mensagem do commit') });
    },
  },
  createProject: (input: { name: string; rootPath: string }) => {
    const value = requireObject(input, 'Dados do projeto');
    return invoke('projects:create', { name: requireNonEmptyString(value.name, 'Nome do projeto'), rootPath: requireNonEmptyString(value.rootPath, 'Pasta do projeto') });
  },
  openFolder: () => invoke<string | null>('projects:open-folder'),
  scanProject: (rootPath: string) => invoke('projects:scan', requireNonEmptyString(rootPath, 'Pasta do projeto')),
  readFile: (filePath: string) => invoke('projects:read-file', requireNonEmptyString(filePath, 'Arquivo')),
  writeFile: (input: { filePath: string; content: string }) => {
    const value = requireObject(input, 'Dados do arquivo');
    return invoke('projects:write-file', { filePath: requireNonEmptyString(value.filePath, 'Arquivo'), content: typeof value.content === 'string' ? value.content : (() => { throw new Error('Conteúdo de arquivo é inválido.'); })() });
  },
  openExternal: (url: string) => invoke('app:open-external', requireNonEmptyString(url, 'URL externa')),
});