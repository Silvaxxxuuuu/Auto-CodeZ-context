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
  const config = providerManager.getConfig(chat.providerId);
  const projectContext = chat.projectId ? await projectManager.buildContext(chat.projectId) : undefined;
  return { chat, config, projectContext };
}

ipcMain.handle('app:get-state', async () => ({ providers: await providerManager.list(), chats: await chatManager.list(), projects: await projectManager.list() }));
ipcMain.handle('providers:list-models', async (_event, providerId: string) => providerManager.listModels(requireIdentifier(providerId, 'Provider')));
ipcMain.handle('providers:list-keys', async () => providerManager.listKeys());
ipcMain.handle('providers:save-key', async (_event, input: unknown) => { const value = requireObject(input, 'Dados da API key'); return providerManager.saveKey({ providerId: requireIdentifier(value.providerId, 'Provider'), name: requireNonEmptyString(value.name, 'Nome da API key'), apiKey: requireNonEmptyString(value.apiKey, 'API key'), model: value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo'), baseUrl: value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base') }); });
ipcMain.handle('providers:rename-key', async (_event, input: unknown) => { const value = requireObject(input, 'Dados do nome da API key'); return providerManager.renameKey(requireIdentifier(value.keyId, 'API key'), requireNonEmptyString(value.name, 'Nome da API key')); });
ipcMain.handle('providers:set-active-key', async (_event, keyId: string) => providerManager.setActiveKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:remove-key', async (_event, keyId: string) => providerManager.removeKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:save', async (_event, input: unknown) => providerManager.save(requireObject(input, 'Dados do provider') as { providerId: string; apiKey: string; model?: string; baseUrl?: string }));
ipcMain.handle('providers:remove', async (_event, providerId: string) => providerManager.remove(requireIdentifier(providerId, 'Provider')));
ipcMain.handle('chat:create', async (_event, input: unknown) => chatManager.create(requireObject(input, 'Dados do chat') as { providerId?: string; model?: string; intelligence: string; permissionLevel: string; projectId?: string }));
ipcMain.handle('chat:delete', async (_event, chatId: string) => chatManager.remove(requireIdentifier(chatId, 'Chat')));
ipcMain.handle('chat:rename', async (_event, input: unknown) => { const value = requireObject(input, 'Dados do nome do chat'); return chatManager.rename(requireIdentifier(value.chatId, 'Chat'), requireNonEmptyString(value.title, 'Nome do chat')); });
ipcMain.handle('chat:update-settings', async (_event, input: unknown) => chatManager.updateSettings(requireObject(input, 'Configurações do chat') as { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }));

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
  if (!isRetryOfPersistedUserMessage) await chatManager.addMessage(chat.id, { role: 'user', content, createdAt: Date.now() });
  const current = (await chatManager.list()).find((item) => item.id === chat.id);
  if (!current) throw new Error('Chat desapareceu durante a execução.');
  const emit = (event: AIStreamEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:stream-event', { ...event, chatId });
  };
  emit({ type: 'start' });
  try {
    const result = await agentRuntime.runStreaming(config, current, projectContext, current.permissionLevel, emit);
    await chatManager.update({ ...current, messages: result.messages });
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id), error: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', error: message });
    return { pendingApprovalIds: [], chat: (await chatManager.list()).find((item) => item.id === chat.id), error: message };
  }
});

ipcMain.handle('agent:list-tools', async () => toolRuntime.listDefinitions());
ipcMain.handle('agent:list-approvals', async () => toolRuntime.listApprovals());
ipcMain.handle('agent:list-interrupted-provider-requests', async () => chatRuntime.listInterruptedProviderRequests());
ipcMain.handle('agent:approve', async (_event, approvalId: string) => { const result = await agentRuntime.resume(requireIdentifier(approvalId, 'Aprovação')); const chat = (await chatManager.list()).find((item) => item.id === result.chatId); if (chat) await chatManager.update({ ...chat, messages: result.messages }); return result; });
ipcMain.handle('agent:deny', async (_event, approvalId: string) => { const result = await agentRuntime.reject(requireIdentifier(approvalId, 'Aprovação')); const chat = (await chatManager.list()).find((item) => item.id === result.chatId); if (chat) await chatManager.update({ ...chat, messages: result.messages }); return result; });

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
ipcMain.handle('git:checkout', async (_event, input: { projectId: string; name: string }) => { const value = requireObject(input, 'Dados do checkout'); return gitService.checkout(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Branch')); });
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