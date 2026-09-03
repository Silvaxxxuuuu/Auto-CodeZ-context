import { app, dialog, ipcMain, Menu, shell, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStorage } from './core/storage';
import { ProviderManager } from './ai/provider-manager';
import { ChatManager } from './ai/chat-manager';
import { ProjectManager } from './project/project-manager';
import { ToolRuntime } from './agent/tool-runtime';
import { AgentRuntime } from './agent/agent-runtime';
import { ChatRuntime } from './ai/chat-runtime';
import { TerminalService, type TerminalEvent } from './agent/terminal-service';
import { GitRuntime } from './agent/git-runtime';
import { GitService } from './agent/git-service';
import { WorkspaceRuntime } from './agent/workspace-runtime';
import { PermissionRuntime } from './agent/permission-runtime';
import { ActivityRuntime } from './agent/activity-runtime';
import { ApprovalRuntime } from './agent/approval-runtime';
import { CommandRuntime } from './agent/command-runtime';
import { DiffRuntime } from './agent/diff-runtime';
import { ExecutionManager } from './execution-manager';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';
import type { AIProviderConfig, AIStreamEvent } from './ai/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storage = new LocalStorage();
const providerManager = new ProviderManager(storage);
const chatManager = new ChatManager(storage);
const projectManager = new ProjectManager(storage);
const workspaceRuntime = new WorkspaceRuntime(() => projectManager.list());
const permissionRuntime = new PermissionRuntime();
const activityRuntime = new ActivityRuntime();
const approvalRuntime = new ApprovalRuntime();
const commandRuntime = new CommandRuntime(() => projectManager.list());
const diffRuntime = new DiffRuntime();
const gitRuntime = new GitRuntime(() => projectManager.list());
const gitService = new GitService(gitRuntime);
const terminalService = new TerminalService(storage, () => projectManager.list());
const toolRuntime = new ToolRuntime(workspaceRuntime, permissionRuntime, activityRuntime, approvalRuntime, commandRuntime, diffRuntime, storage);
toolRuntime.configureGitRuntime(gitRuntime);
const chatRuntime = new ChatRuntime(providerManager.registry, undefined, undefined, activityRuntime, undefined, toolRuntime.listDefinitions());
const agentRuntime = new AgentRuntime(chatRuntime, toolRuntime, activityRuntime, storage);
const executionManager = new ExecutionManager();
let mainWindow: BrowserWindow | null = null;

function sendTerminalEvent(event: unknown): void { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:event', event); }
function sendActivity(event: unknown): void { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:activity', event); }

function createWindow(): void {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 960, minHeight: 680, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function getChatContext(chatId: string): Promise<{ chat: Awaited<ReturnType<ChatManager['list']>>[number]; config: AIProviderConfig; projectContext?: string }> {
  const chat = (await chatManager.list()).find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  const config = chat.apiKeyId ? providerManager.getConfigForKey(chat.apiKeyId) : providerManager.getConfig(chat.providerId);
  if (chat.apiKeyId && config.id !== chat.providerId) throw new Error('A API key selecionada não pertence ao provider salvo neste chat.');
  const projectContext = chat.projectId ? await projectManager.buildContext(chat.projectId) : undefined;
  return { chat, config, projectContext };
}

ipcMain.handle('app:get-state', async () => ({ providers: await providerManager.list(), chats: await chatManager.list(), projects: await projectManager.list() }));
ipcMain.handle('providers:list-models', async (_event, identifier: string) => {
  const value = requireIdentifier(identifier, 'Provider');
  const key = (await providerManager.listKeys()).find((item) => item.id === value);
  return key ? providerManager.listModelsForKey(value) : providerManager.listModels(value);
});
ipcMain.handle('providers:list-models-for-key', async (_event, keyId: string) => providerManager.listModelsForKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:list-keys', async () => providerManager.listKeys());
ipcMain.handle('providers:save-key', async (_event, input: unknown) => { const value = requireObject(input, 'Dados da API key'); return providerManager.saveKey({ providerId: requireIdentifier(value.providerId, 'Provider'), name: requireNonEmptyString(value.name, 'Nome da API key'), apiKey: requireNonEmptyString(value.apiKey, 'API key'), model: value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo'), baseUrl: value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base') }); });
ipcMain.handle('providers:rename-key', async (_event, input: unknown) => { const value = requireObject(input, 'Dados do nome da API key'); return providerManager.renameKey(requireIdentifier(value.keyId, 'API key'), requireNonEmptyString(value.name, 'Nome da API key')); });
ipcMain.handle('providers:set-active-key', async (_event, keyId: string) => providerManager.setActiveKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:remove-key', async (_event, keyId: string) => providerManager.removeKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:save', async (_event, input: unknown) => providerManager.save(requireObject(input, 'Dados do provider') as { providerId: string; apiKey: string; model?: string; baseUrl?: string }));
ipcMain.handle('providers:remove', async (_event, providerId: string) => providerManager.remove(requireIdentifier(providerId, 'Provider')));
ipcMain.handle('chat:create', async (_event, input: unknown) => chatManager.create(requireObject(input, 'Dados do chat') as { providerId?: string; model?: string; apiKeyId?: string; intelligence: string; permissionLevel: string; projectId?: string }));
ipcMain.handle('chat:delete', async (_event, chatId: string) => chatManager.remove(requireIdentifier(chatId, 'Chat')));
ipcMain.handle('chat:rename', async (_event, input: unknown) => { const value = requireObject(input, 'Dados do nome do chat'); return chatManager.rename(requireIdentifier(value.chatId, 'Chat'), requireNonEmptyString(value.title, 'Nome do chat')); });
ipcMain.handle('chat:update-settings', async (_event, input: unknown) => {
  const value = requireObject(input, 'Configurações do chat');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const requestedProviderId = requireIdentifier(value.providerId, 'Provider');
  const explicitApiKeyId = value.apiKeyId === undefined ? undefined : requireIdentifier(value.apiKeyId, 'API key');
  const selectedKey = explicitApiKeyId ? (await providerManager.listKeys()).find((item) => item.id === explicitApiKeyId) : (await providerManager.listKeys()).find((item) => item.id === requestedProviderId);
  const apiKeyId = explicitApiKeyId || selectedKey?.id;
  const providerId = selectedKey?.providerId || requestedProviderId;
  if (apiKeyId) {
    const config = providerManager.getConfigForKey(apiKeyId);
    if (config.id !== providerId) throw new Error('A API key selecionada não pertence ao provider informado.');
  }
  return chatManager.updateSettings({ chatId, providerId, model: requireIdentifier(value.model, 'Modelo'), apiKeyId, intelligence: requireIdentifier(value.intelligence, 'Inteligência'), permissionLevel: requireIdentifier(value.permissionLevel, 'Permissão') });
});

async function executeChat(chatId: string, content: string): Promise<{ pendingApprovalIds: string[]; chat: Awaited<ReturnType<ChatManager['list']>>[number] | undefined }> {
  const { chat, config, projectContext } = await getChatContext(chatId);
  await chatManager.addMessage(chat.id, { role: 'user', content, createdAt: Date.now() });
  const current = (await chatManager.list()).find((item) => item.id === chat.id);
  if (!current) throw new Error('Chat desapareceu durante a execução.');
  const result = await agentRuntime.run(config, current, projectContext, current.permissionLevel);
  await chatManager.update({ ...current, messages: result.messages });
  return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
}

ipcMain.handle('chat:send', async (_event, input: { chatId: string; content: string }) => { const value = requireObject(input, 'Mensagem'); return executeChat(requireIdentifier(value.chatId, 'Chat'), requireNonEmptyString(value.content, 'Mensagem')); });
ipcMain.handle('chat:stream', async (_event, input: { chatId: string; content: string }) => {
  const value = requireObject(input, 'Mensagem');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const content = requireNonEmptyString(value.content, 'Mensagem');
  const { chat, config, projectContext } = await getChatContext(chatId);
  const lastMessage = chat.messages.at(-1);
  const isRetryOfPersistedUserMessage = lastMessage?.role === 'user' && lastMessage.content === content;
  const current = (await chatManager.list()).find((item) => item.id === chat.id);
  if (!current) throw new Error('Chat desapareceu durante a execução.');

  let execution;
  try {
    execution = executionManager.start(chatId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:stream-event', { type: 'error', chatId, error: message });
    return { pendingApprovalIds: [], chat: current, error: message };
  }

  const emit = (event: AIStreamEvent): void => {
    try {
      if (event.type === 'approval_required') executionManager.update(chatId, { state: 'waiting_approval' });
      else if (event.type === 'error') executionManager.update(chatId, { state: 'failed', error: event.error });
      else if (event.type === 'tool_call') executionManager.update(chatId, { state: 'running', currentTool: event.toolCall?.name });
    } catch {
      // Execution bookkeeping must never interrupt the provider stream.
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:stream-event', { ...event, chatId, runId: execution.runId });
  };

  emit({ type: 'start' });
  try {
    if (!isRetryOfPersistedUserMessage) await chatManager.addMessage(chat.id, { role: 'user', content, createdAt: Date.now() });
    const workingChat = (await chatManager.list()).find((item) => item.id === chat.id);
    if (!workingChat) throw new Error('Chat desapareceu durante a execução.');
    const result = await agentRuntime.runStreaming(config, workingChat, projectContext, workingChat.permissionLevel, emit);
    await chatManager.update({ ...workingChat, messages: result.messages });
    if (result.pendingApprovalIds.length) executionManager.update(chatId, { state: 'waiting_approval' });
    else if (executionManager.get(chatId)?.state === 'running') executionManager.update(chatId, { state: 'completed' });
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id), error: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executionManager.update(chatId, { state: 'failed', error: message });
    emit({ type: 'error', error: message });
    return { pendingApprovalIds: [], chat: (await chatManager.list()).find((item) => item.id === chat.id), error: message };
  }
});

ipcMain.handle('agent:list-tools', async () => toolRuntime.listDefinitions());
ipcMain.handle('agent:list-approvals', async () => toolRuntime.listApprovals());
ipcMain.handle('agent:list-executions', async (_event, chatId?: string) => chatId === undefined ? executionManager.list() : executionManager.get(requireIdentifier(chatId, 'Chat')) ?? null);
ipcMain.handle('agent:list-interrupted-provider-requests', async () => chatRuntime.listInterruptedProviderRequests());
ipcMain.handle('agent:approve', async (_event, approvalId: string) => {
  const id = requireIdentifier(approvalId, 'Aprovação');
  const approval = toolRuntime.listApprovals().find((item) => item.id === id);
  if (!approval?.chatId) throw new Error('Aprovação sem chat associado.');
  const chatId = approval.chatId;
  executionManager.update(chatId, { state: 'running' });
  try {
    const result = await agentRuntime.resume(id);
    const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
    if (chat) await chatManager.update({ ...chat, messages: result.messages });
    if (result.pendingApprovalIds.length) executionManager.update(chatId, { state: 'waiting_approval' });
    else executionManager.update(chatId, { state: 'completed' });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executionManager.update(chatId, { state: 'failed', error: message });
    throw error;
  }
});
ipcMain.handle('agent:deny', async (_event, approvalId: string) => {
  const id = requireIdentifier(approvalId, 'Aprovação');
  const approval = toolRuntime.listApprovals().find((item) => item.id === id);
  if (!approval?.chatId) throw new Error('Aprovação sem chat associado.');
  const chatId = approval.chatId;
  executionManager.update(chatId, { state: 'running' });
  try {
    const result = await agentRuntime.reject(id);
    const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
    if (chat) await chatManager.update({ ...chat, messages: result.messages });
    if (result.pendingApprovalIds.length) executionManager.update(chatId, { state: 'waiting_approval' });
    else executionManager.update(chatId, { state: 'completed' });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executionManager.update(chatId, { state: 'failed', error: message });
    throw error;
  }
});

ipcMain.handle('terminal:start', async (_event, input: { projectId: string; command: string }) => { const value = requireObject(input, 'Dados do terminal'); return terminalService.start(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.command, 'Comando')); });
ipcMain.handle('terminal:kill', async (_event, sessionId: string) => terminalService.kill(requireIdentifier(sessionId, 'Sessão do terminal')));
ipcMain.handle('terminal:list-sessions', async () => terminalService.listSessions());
ipcMain.handle('terminal:get-output', async (_event, sessionId: string) => terminalService.getOutput(requireIdentifier(sessionId, 'Sessão do terminal')));
ipcMain.handle('terminal:list-history', async (_event, projectId?: string) => terminalService.listHistory(projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('terminal:clear-history', async (_event, projectId?: string) => terminalService.clearHistory(projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')));

ipcMain.handle('git:status', async (_event, projectId: string) => gitService.status(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:branches', async (_event, projectId: string) => gitService.branches(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:diff', async (_event, projectId: string) => gitService.diff(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:log', async (_event, input: { projectId: string; limit?: number }) => { const value = requireObject(input, 'Dados do histórico Git'); const projectId = requireIdentifier(value.projectId, 'Projeto'); const limit = value.limit === undefined ? undefined : Number(value.limit); if (limit !== undefined && !Number.isFinite(limit)) throw new Error('Limite do histórico Git inválido.'); return gitService.log(projectId, limit); });
ipcMain.handle('git:create-branch', async (_event, input: { projectId: string; name: string }) => { const value = requireObject(input, 'Dados da branch'); return gitService.createBranch(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Nome da branch')); });
ipcMain.handle('git:checkout', async (_event, input: { projectId: string; name: string }) => { const value = requireObject(input, 'Dados do checkout'); return gitService.checkout(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Nome da branch')); });
ipcMain.handle('git:stage', async (_event, input: { projectId: string; paths: string[] }) => { const value = requireObject(input, 'Dados do staging'); if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== 'string')) throw new Error('Arquivos do staging inválidos.'); return gitService.stage(requireIdentifier(value.projectId, 'Projeto'), value.paths.map((item) => requireNonEmptyString(item, 'Arquivo'))); });
ipcMain.handle('git:stage-all', async (_event, projectId: string) => gitService.stageAll(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:commit', async (_event, input: { projectId: string; message: string }) => { const value = requireObject(input, 'Dados do commit'); return gitService.commit(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.message, 'Mensagem')); });

ipcMain.handle('projects:create', async (_event, input: { name: string; rootPath: string }) => { const value = requireObject(input, 'Dados do projeto'); return projectManager.create(requireNonEmptyString(value.name, 'Nome do projeto'), requireNonEmptyString(value.rootPath, 'Pasta do projeto')); });
ipcMain.handle('projects:open-folder', async () => { if (!mainWindow || mainWindow.isDestroyed()) throw new Error('A janela principal não está disponível.'); const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] || null; });
ipcMain.handle('projects:list', async () => projectManager.list());
ipcMain.handle('projects:delete', async (_event, projectId: string) => projectManager.remove(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('projects:scan', async (_event, rootPath: string) => projectManager.scan(requireNonEmptyString(rootPath, 'Pasta do projeto')));
ipcMain.handle('projects:read-file', async (_event, filePath: string) => projectManager.readFile(requireNonEmptyString(filePath, 'Arquivo')));
ipcMain.handle('projects:write-file', async (_event, input: { filePath: string; content: string }) => { const value = requireObject(input, 'Dados do arquivo'); await projectManager.writeFile(requireNonEmptyString(value.filePath, 'Arquivo'), typeof value.content === 'string' ? value.content : (() => { throw new Error('Conteúdo de arquivo é inválido.'); })()); return { ok: true }; });
ipcMain.handle('app:open-external', async (_event, url: string) => shell.openExternal(requireNonEmptyString(url, 'URL externa')));

app.whenReady().then(async () => {
  await storage.init();
  await providerManager.init();
  await chatManager.init();
  await projectManager.init();
  await terminalService.init();
  await chatRuntime.init();
  await toolRuntime.init();
  await agentRuntime.init();
  activityRuntime.subscribe((event) => sendActivity(event));
  terminalService.subscribe((event: TerminalEvent) => sendTerminalEvent(event));
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
