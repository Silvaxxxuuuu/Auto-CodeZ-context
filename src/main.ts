import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStorage } from './core/storage';
import { ProviderManager } from './ai/provider-manager';
import { ChatManager } from './ai/chat-manager';
import { ProjectManager } from './project/project-manager';
import { ToolRuntime } from './agent/tool-runtime';
import { AgentRuntime } from './agent/agent-runtime';
import { ChatRuntime } from './ai/chat-runtime';
import { TerminalService } from './agent/terminal-service';
import { GitRuntime } from './agent/git-runtime';
import { GitService } from './agent/git-service';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';
import type { AIConfig, AIStreamEvent, IntelligenceLevel, PermissionLevel } from './ai/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storage = new LocalStorage();
const providerManager = new ProviderManager(storage);
const chatManager = new ChatManager(storage);
const projectManager = new ProjectManager(storage);
const gitRuntime = new GitRuntime(() => projectManager.list());
const gitService = new GitService(gitRuntime);
const terminalService = new TerminalService(storage, projectManager);
const toolRuntime = new ToolRuntime(projectManager, storage, terminalService);
toolRuntime.configureGitRuntime(gitRuntime);
const chatRuntime = new ChatRuntime(storage, providerManager);
const agentRuntime = new AgentRuntime(providerManager, toolRuntime, chatRuntime, storage, projectManager);
let mainWindow: BrowserWindow | null = null;

const runningChats = new Set<string>();
function beginChatRun(chatId: string): void { runningChats.add(chatId); }
function endChatRun(chatId: string): void { runningChats.delete(chatId); }

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void mainWindow.loadFile(path.join(__dirname, '../index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function loadProviders(): Promise<void> {
  await providerManager.init();
}

async function getChatContext(chatId: string, content?: string) {
  const chats = await chatManager.list();
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  const projectContext = chat.projectId ? await projectManager.buildContext(chat.projectId) : undefined;
  const config: AIConfig = { providerId: chat.providerId, model: chat.model, intelligence: chat.intelligence as IntelligenceLevel };
  return { chat, config, projectContext, content };
}

ipcMain.handle('app:get-state', async () => ({ providers: await providerManager.list(), chats: await chatManager.list(), projects: await projectManager.list() }));
ipcMain.handle('providers:list-models', async (_event, providerId: string) => providerManager.listModels(requireIdentifier(providerId, 'Provider')));
ipcMain.handle('providers:save', async (_event, input: unknown) => providerManager.save(input));
ipcMain.handle('providers:remove', async (_event, providerId: string) => providerManager.remove(requireIdentifier(providerId, 'Provider')));
ipcMain.handle('chat:create', async (_event, input: unknown) => chatManager.create(input));
ipcMain.handle('chat:delete', async (_event, chatId: string) => chatManager.remove(requireIdentifier(chatId, 'Chat')));
ipcMain.handle('chat:update-settings', async (_event, input: unknown) => chatManager.updateSettings(input));
ipcMain.handle('chat:send', async (_event, input: { chatId: string; content: string }) => {
  const value = requireObject(input, 'Mensagem');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const content = requireNonEmptyString(value.content, 'Mensagem');
  const { chat, config, projectContext } = await getChatContext(chatId, content);
  beginChatRun(chat.id);
  try {
    await chatManager.addMessage(chat.id, { role: 'user', content });
    const current = (await chatManager.list()).find((item) => item.id === chat.id);
    if (!current) throw new Error('Chat desapareceu durante a execução.');
    const result = await agentRuntime.run(config, current, projectContext, current.permissionLevel);
    await chatManager.update({ ...current, messages: result.messages });
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
  } finally {
    endChatRun(chat.id);
  }
});
ipcMain.handle('chat:stream', async (_event, input: { chatId: string; content: string }) => {
  const value = requireObject(input, 'Mensagem');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const content = requireNonEmptyString(value.content, 'Mensagem');
  const { chat, config, projectContext } = await getChatContext(chatId, content);
  beginChatRun(chat.id);
  try {
    await chatManager.addMessage(chat.id, { role: 'user', content });
    const current = (await chatManager.list()).find((item) => item.id === chat.id);
    if (!current) throw new Error('Chat desapareceu durante a execução.');
    const emit = (event: AIStreamEvent): void => { mainWindow?.webContents.send('chat:stream-event', event); };
    emit({ type: 'start' });
    const result = await agentRuntime.runStreaming(config, current, projectContext, current.permissionLevel, emit);
    await chatManager.update({ ...current, messages: result.messages });
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
  } finally {
    endChatRun(chat.id);
  }
});

ipcMain.handle('agent:list-tools', async () => toolRuntime.listDefinitions());
ipcMain.handle('agent:list-approvals', async () => toolRuntime.listApprovals());
ipcMain.handle('agent:list-interrupted-provider-requests', async () => chatRuntime.listInterruptedProviderRequests());
ipcMain.handle('agent:approve', async (_event, approvalId: string) => {
  const id = requireIdentifier(approvalId, 'Aprovação');
  const result = await agentRuntime.resume(id);
  const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
  if (chat) await chatManager.update({ ...chat, messages: result.messages });
  endChatRun(result.chatId);
  return result;
});
ipcMain.handle('agent:deny', async (_event, approvalId: string) => {
  const id = requireIdentifier(approvalId, 'Aprovação');
  const result = await agentRuntime.reject(id);
  const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
  if (chat) await chatManager.update({ ...chat, messages: result.messages });
  endChatRun(result.chatId);
  return result;
});

ipcMain.handle('terminal:start', async (_event, input: { projectId: string; command: string }) => {
  const value = requireObject(input, 'Dados do terminal');
  return terminalService.start(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.command, 'Comando'));
});
ipcMain.handle('terminal:kill', async (_event, sessionId: string) => terminalService.kill(requireIdentifier(sessionId, 'Sessão do terminal')));
ipcMain.handle('terminal:list-sessions', async () => terminalService.listSessions());
ipcMain.handle('terminal:get-output', async (_event, sessionId: string) => terminalService.getOutput(requireIdentifier(sessionId, 'Sessão do terminal')));
ipcMain.handle('terminal:list-history', async (_event, projectId?: string) => terminalService.listHistory(projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('terminal:clear-history', async (_event, projectId?: string) => terminalService.clearHistory(projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')));

ipcMain.handle('git:status', async (_event, projectId: string) => gitService.status(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:branches', async (_event, projectId: string) => gitService.branches(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:diff', async (_event, projectId: string) => gitService.diff(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:log', async (_event, input: { projectId: string; limit?: number }) => {
  const value = requireObject(input, 'Dados do histórico Git');
  const projectId = requireIdentifier(value.projectId, 'Projeto');
  const limit = value.limit === undefined ? undefined : Number(value.limit);
  if (limit !== undefined && !Number.isFinite(limit)) throw new Error('Limite do histórico Git inválido.');
  return gitService.log(projectId, limit);
});
ipcMain.handle('git:create-branch', async (_event, input: { projectId: string; name: string }) => {
  const value = requireObject(input, 'Dados da branch');
  return gitService.createBranch(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Nome da branch'));
});
ipcMain.handle('git:checkout', async (_event, input: { projectId: string; name: string }) => {
  const value = requireObject(input, 'Dados do checkout');
  return gitService.checkout(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Branch'));
});
ipcMain.handle('git:stage', async (_event, input: { projectId: string; paths: string[] }) => {
  const value = requireObject(input, 'Dados do staging');
  if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== 'string')) throw new Error('Arquivos do staging inválidos.');
  return gitService.stage(requireIdentifier(value.projectId, 'Projeto'), value.paths.map((item) => requireNonEmptyString(item, 'Arquivo')));
});
ipcMain.handle('git:stage-all', async (_event, projectId: string) => gitService.stageAll(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:commit', async (_event, input: { projectId: string; message: string }) => {
  const value = requireObject(input, 'Dados do commit');
  return gitService.commit(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.message, 'Mensagem do commit'));
});

ipcMain.handle('projects:create', async (_event, input: { name: string; rootPath: string }) => {
  try {
    const value = requireObject(input, 'Dados do projeto');
    const name = requireNonEmptyString(value.name, 'Nome do projeto');
    const rootPath = requireNonEmptyString(value.rootPath, 'Pasta do projeto');
    return await projectManager.create(name, rootPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível criar o projeto.';
    if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, { type: 'error', title: 'Não foi possível criar o projeto', message });
    throw error;
  }
});
ipcMain.handle('projects:open-folder', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('A janela principal não está disponível.');
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? undefined : result.filePaths[0];
});
ipcMain.handle('projects:list', async () => projectManager.list());
ipcMain.handle('projects:delete', async (_event, projectId: string) => projectManager.remove(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('app:open-external', async (_event, url: string) => shell.openExternal(requireNonEmptyString(url, 'URL')));

app.whenReady().then(async () => {
  await loadProviders();
  await toolRuntime.init();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
