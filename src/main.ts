import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { ProviderRegistry } from './ai/provider-registry';
import { ChatRuntime } from './ai/chat-runtime';
import { ModelResolver } from './ai/model-resolver';
import { OpenAIAdapter } from './ai/providers/openai';
import { GoogleAdapter } from './ai/providers/google';
import { AnthropicAdapter } from './ai/providers/anthropic';
import type { AIProviderConfig, ChatRecord, IntelligenceLevel, PermissionLevel, ProviderId, AIStreamEvent } from './ai/types';
import { LocalStorage } from './core/storage';
import { ProjectManager } from './core/project-manager';
import { ChatManager, UNCONFIGURED_MODEL_ID, UNCONFIGURED_PROVIDER_ID } from './core/chat-manager';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';
import { ActivityRuntime } from './agent/activity-runtime';
import { WorkspaceRuntime } from './agent/workspace-runtime';
import { ToolRuntime } from './agent/tool-runtime';
import { AgentRuntime } from './agent/agent-runtime';
import { ApprovalRuntime } from './agent/approval-runtime';
import { ProjectContextRuntime } from './agent/project-context-runtime';
import { CommandRuntime } from './agent/command-runtime';

if (started) app.quit();

const storage = new LocalStorage();
const registry = new ProviderRegistry();
registry.register(new OpenAIAdapter());
registry.register(new GoogleAdapter());
registry.register(new AnthropicAdapter());
const modelResolver = new ModelResolver(registry);
const activityRuntime = new ActivityRuntime();
const approvalRuntime = new ApprovalRuntime();
const projectManager = new ProjectManager(storage);
const projectContextRuntime = new ProjectContextRuntime(projectManager);
const workspaceRuntime = new WorkspaceRuntime(() => projectManager.list());
const commandRuntime = new CommandRuntime(() => projectManager.list());
const toolRuntime = new ToolRuntime(workspaceRuntime, undefined, activityRuntime, approvalRuntime, commandRuntime);
const chatRuntime = new ChatRuntime(registry, undefined, undefined, activityRuntime, modelResolver, toolRuntime.listDefinitions());
const agentRuntime = new AgentRuntime(chatRuntime, toolRuntime, activityRuntime);
const chatManager = new ChatManager(storage);

let providerConfigs: AIProviderConfig[] = [];
let providerKeys: Record<string, string> = {};
let mainWindow: BrowserWindow | null = null;
const busyChats = new Set<string>();

const defaultProviders: AIProviderConfig[] = [
  { id: 'openai', displayName: 'OpenAI', apiKey: '', enabled: false },
  { id: 'google', displayName: 'Google AI', apiKey: '', enabled: false },
  { id: 'anthropic', displayName: 'Anthropic', apiKey: '', enabled: false },
];

const intelligenceLevels = new Set<IntelligenceLevel>(['low', 'normal', 'high', 'maximum']);
const permissionLevels = new Set<PermissionLevel>(['read-only', 'safe', 'ask', 'unrestricted']);

function requireIntelligence(value: unknown): IntelligenceLevel {
  const normalized = requireIdentifier(value, 'Inteligência');
  if (!intelligenceLevels.has(normalized as IntelligenceLevel)) throw new Error('Inteligência inválida.');
  return normalized as IntelligenceLevel;
}

function requirePermission(value: unknown): PermissionLevel {
  const normalized = requireIdentifier(value, 'Permissão');
  if (!permissionLevels.has(normalized as PermissionLevel)) throw new Error('Permissão inválida.');
  return normalized as PermissionLevel;
}

activityRuntime.subscribe((event) => { mainWindow?.webContents.send('agent:activity', event); });

async function loadProviders(): Promise<void> {
  providerConfigs = await storage.read<AIProviderConfig[]>('providers.json', defaultProviders);
  const encrypted = await storage.readEncrypted('provider-keys.dat');
  try {
    const parsed = encrypted ? JSON.parse(encrypted) : {};
    providerKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    providerKeys = {};
  }
  providerConfigs = providerConfigs.map((config) => ({ ...config, apiKey: providerKeys[config.id] || '' }));
}

async function saveProviders(): Promise<void> {
  providerKeys = {};
  for (const config of providerConfigs) if (config.apiKey) providerKeys[config.id] = config.apiKey;
  const configsWithoutKeys = providerConfigs.map((config) => {
    const { apiKey, ...safeConfig } = config;
    void apiKey;
    return safeConfig;
  });
  await storage.write('providers.json', configsWithoutKeys);
  await storage.writeEncrypted('provider-keys.dat', JSON.stringify(providerKeys));
}

function publicProviders() {
  return registry.summaries(providerConfigs).map((summary) => ({ ...summary, apiKeyConfigured: Boolean(providerKeys[summary.id]) }));
}

async function getConfiguredProvider(providerId: ProviderId): Promise<AIProviderConfig> {
  const config = providerConfigs.find((item) => item.id === providerId);
  if (!config?.enabled || !config.apiKey) throw new Error('O provider selecionado não está configurado.');
  return config;
}

async function validateChatInput(input: { providerId: ProviderId; model: string; projectId?: string }): Promise<void> {
  if (input.providerId === UNCONFIGURED_PROVIDER_ID && input.model === UNCONFIGURED_MODEL_ID) {
    if (input.projectId && !(await projectManager.list()).some((project) => project.id === input.projectId)) throw new Error('Projeto não encontrado.');
    return;
  }
  const config = await getConfiguredProvider(input.providerId);
  const models = await modelResolver.list(config);
  const model = modelResolver.find(models, input.model);
  if (model.providerId !== input.providerId) throw new Error('O modelo não pertence ao provider selecionado.');
  if (input.projectId && !(await projectManager.list()).some((project) => project.id === input.projectId)) throw new Error('Projeto não encontrado.');
}

function beginChatRun(chatId: string): void {
  if (busyChats.has(chatId) || agentRuntime.hasPendingForChat(chatId)) throw new Error('Este chat já possui uma operação em andamento.');
  busyChats.add(chatId);
}

function endChatRun(chatId: string): void {
  if (!agentRuntime.hasPendingForChat(chatId)) busyChats.delete(chatId);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 1050, minHeight: 700, backgroundColor: '#090b0f', title: 'Auto CodeZ', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  if (process.env.AUTO_CODEZ_SMOKE === '1') {
    const bridgeReady = await mainWindow.webContents.executeJavaScript('Boolean(window.autoCodez && typeof window.autoCodez.getState === "function")');
    if (!bridgeReady) throw new Error('Smoke test: preload bridge não foi exposto.');
    const uiReady = await mainWindow.webContents.executeJavaScript('Boolean(document.querySelector("#app .app-shell") && document.querySelector("#prompt") && document.querySelector("#send-button"))');
    if (!uiReady) throw new Error('Smoke test: interface principal não foi montada.');
    setTimeout(() => app.quit(), 250);
  }
}

ipcMain.handle('app:get-state', async () => ({ providers: publicProviders(), chats: await chatManager.list(), projects: await projectManager.list() }));
ipcMain.handle('providers:list-models', async (_event, providerId: ProviderId) => {
  const id = requireIdentifier(providerId, 'Provider');
  const config = await getConfiguredProvider(id as ProviderId);
  return modelResolver.list(config);
});
ipcMain.handle('providers:save', async (_event, input: { providerId: ProviderId; apiKey: string; model?: string; baseUrl?: string }) => {
  try {
    const value = requireObject(input, 'Dados do provider');
    const providerId = requireIdentifier(value.providerId, 'Provider') as ProviderId;
    const apiKey = requireNonEmptyString(value.apiKey, 'API key');
    const model = value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo');
    const baseUrl = value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base');
    const adapter = registry.get(providerId);
    const existing = providerConfigs.find((item) => item.id === providerId);
    const config: AIProviderConfig = { id: providerId, displayName: adapter.displayName, apiKey, enabled: true, selectedModel: model, baseUrl: baseUrl || undefined };
    const models = await modelResolver.list(config, true);
    if (!models.length) throw new Error('O provider não retornou modelos utilizáveis.');
    if (config.selectedModel && !models.some((item) => item.id === config.selectedModel)) throw new Error('O modelo selecionado não pertence aos modelos disponíveis do provider.');
    if (!config.selectedModel && models[0]) config.selectedModel = models[0].id;
    if (existing) providerConfigs = providerConfigs.map((item) => item.id === providerId ? config : item); else providerConfigs.push(config);
    await saveProviders();
    return { providers: publicProviders(), models };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao validar o provider.';
    if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, { type: 'error', title: 'Não foi possível configurar a IA', message });
    throw error;
  }
});
ipcMain.handle('providers:remove', async (_event, providerId: ProviderId) => {
  const id = requireIdentifier(providerId, 'Provider') as ProviderId;
  providerConfigs = providerConfigs.filter((item) => item.id !== id);
  delete providerKeys[id];
  modelResolver.invalidate(id);
  await saveProviders();
  return publicProviders();
});
ipcMain.handle('chat:create', async (_event, input: { providerId?: ProviderId; model?: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel; projectId?: string }) => {
  const value = requireObject(input, 'Dados do chat');
  const providerId = value.providerId === undefined ? UNCONFIGURED_PROVIDER_ID : requireIdentifier(value.providerId, 'Provider') as ProviderId;
  const model = value.model === undefined ? UNCONFIGURED_MODEL_ID : requireIdentifier(value.model, 'Modelo');
  const intelligence = requireIntelligence(value.intelligence);
  const permissionLevel = requirePermission(value.permissionLevel);
  const projectId = value.projectId === undefined ? undefined : requireIdentifier(value.projectId, 'Projeto');
  await validateChatInput({ providerId, model, projectId });
  return chatManager.create({ providerId, model, intelligence, permissionLevel, projectId });
});
ipcMain.handle('chat:delete', async (_event, chatId: string) => {
  const id = requireIdentifier(chatId, 'Chat');
  if (busyChats.has(id) || agentRuntime.hasPendingForChat(id)) throw new Error('Não é possível excluir um chat durante uma operação.');
  await chatManager.delete(id);
  return chatManager.list();
});
ipcMain.handle('chat:update-settings', async (_event, input: { chatId: string; providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel }) => {
  const value = requireObject(input, 'Configurações do chat');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const providerId = requireIdentifier(value.providerId, 'Provider') as ProviderId;
  const model = requireIdentifier(value.model, 'Modelo');
  const intelligence = requireIntelligence(value.intelligence);
  const permissionLevel = requirePermission(value.permissionLevel);
  const chat = (await chatManager.list()).find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  if (busyChats.has(chat.id) || agentRuntime.hasPendingForChat(chat.id)) throw new Error('Não é possível alterar as configurações durante uma operação.');
  const providerOrModelChanged = chat.providerId !== providerId || chat.model !== model;
  if (providerOrModelChanged) await validateChatInput({ providerId, model });
  const updated: ChatRecord = { ...chat, providerId, model, intelligence, permissionLevel };
  await chatManager.update(updated);
  return updated;
});

async function getChatContext(chatId: string, taskQuery: string): Promise<{ chat: ChatRecord; config: AIProviderConfig; projectContext?: string }> {
  const chat = (await chatManager.list()).find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  if (chat.providerId === UNCONFIGURED_PROVIDER_ID || chat.model === UNCONFIGURED_MODEL_ID) throw new Error('Configure uma IA e um modelo neste chat antes de enviar uma mensagem.');
  const config = await getConfiguredProvider(chat.providerId);
  const models = await modelResolver.list(config);
  modelResolver.find(models, chat.model);
  const projectContext = chat.projectId ? await projectContextRuntime.build(chat.projectId, taskQuery) : undefined;
  return { chat, config, projectContext };
}

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
    return { response: result.response, pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
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
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Escolha a pasta do projeto', buttonLabel: 'Selecionar pasta', properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
ipcMain.handle('projects:scan', async (_event, rootPath: string) => projectManager.scan(requireNonEmptyString(rootPath, 'Pasta do projeto')));
ipcMain.handle('projects:read-file', async (_event, filePath: string) => projectManager.readFile(requireNonEmptyString(filePath, 'Arquivo')));
ipcMain.handle('projects:write-file', async (_event, input: { filePath: string; content: string }) => {
  const value = requireObject(input, 'Dados do arquivo');
  const filePath = requireNonEmptyString(value.filePath, 'Arquivo');
  if (typeof value.content !== 'string') throw new Error('Conteúdo do arquivo é inválido.');
  return projectManager.writeFile(filePath, value.content);
});
ipcMain.handle('app:open-external', async (_event, url: string) => {
  const rawUrl = requireNonEmptyString(url, 'URL externa');
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error('URL externa inválida.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Somente URLs HTTP e HTTPS podem ser abertas.');
  await shell.openExternal(parsed.toString());
});

app.whenReady().then(async () => { await storage.init(); await loadProviders(); await projectManager.init(); await chatManager.init(); await createWindow(); app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); }); }).catch((error) => { const message = error instanceof Error ? error.message : 'Falha ao inicializar o Auto CodeZ.'; dialog.showErrorBox('Auto CodeZ', message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
