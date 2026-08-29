import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { ProviderRegistry } from './ai/provider-registry';
import { ChatRuntime } from './ai/chat-runtime';
import { ModelResolver } from './ai/model-resolver';
import { OpenAIAdapter } from './ai/providers/openai';
import { GoogleAdapter } from './ai/providers/google';
import { AnthropicAdapter } from './ai/providers/anthropic';
import type { AIProviderConfig, ChatRecord, IntelligenceLevel, PermissionLevel, ProviderId, AIToolCall, AIStreamEvent } from './ai/types';
import { LocalStorage } from './core/storage';
import { ProjectManager } from './core/project-manager';
import { ChatManager } from './core/chat-manager';
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

const defaultProviders: AIProviderConfig[] = [
  { id: 'openai', displayName: 'OpenAI', apiKey: '', enabled: false },
  { id: 'google', displayName: 'Google AI', apiKey: '', enabled: false },
  { id: 'anthropic', displayName: 'Anthropic', apiKey: '', enabled: false },
];

activityRuntime.subscribe((event) => { mainWindow?.webContents.send('agent:activity', event); });

async function loadProviders(): Promise<void> {
  providerConfigs = await storage.read<AIProviderConfig[]>('providers.json', defaultProviders);
  providerKeys = JSON.parse((await storage.readEncrypted('provider-keys.dat')) || '{}') as Record<string, string>;
  providerConfigs = providerConfigs.map((config) => ({ ...config, apiKey: providerKeys[config.id] || '' }));
}

async function saveProviders(): Promise<void> {
  providerKeys = {};
  for (const config of providerConfigs) if (config.apiKey) providerKeys[config.id] = config.apiKey;
  await storage.write('providers.json', providerConfigs.map(({ apiKey: _apiKey, ...config }) => config));
  await storage.writeEncrypted('provider-keys.dat', JSON.stringify(providerKeys));
}

function publicProviders() { return registry.summaries(providerConfigs).map((summary) => ({ ...summary, apiKeyConfigured: Boolean(providerKeys[summary.id]) })); }

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 1050, minHeight: 700, backgroundColor: '#090b0f', title: 'Auto CodeZ', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.on('closed', () => { mainWindow = null; });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

ipcMain.handle('app:get-state', async () => ({ providers: publicProviders(), chats: await chatManager.list(), projects: await projectManager.list() }));
ipcMain.handle('providers:list-models', async (_event, providerId: ProviderId) => { const config = providerConfigs.find((item) => item.id === providerId); if (!config?.apiKey) throw new Error('Configure a API key primeiro.'); return modelResolver.list(config); });
ipcMain.handle('providers:save', async (_event, input: { providerId: ProviderId; apiKey: string; model?: string; baseUrl?: string }) => {
  const adapter = registry.get(input.providerId);
  const existing = providerConfigs.find((item) => item.id === input.providerId);
  const config: AIProviderConfig = { id: input.providerId, displayName: adapter.displayName, apiKey: input.apiKey.trim(), enabled: true, selectedModel: input.model, baseUrl: input.baseUrl?.trim() || undefined };
  if (!config.apiKey) throw new Error('API key não pode estar vazia.');
  const models = await modelResolver.list(config, true);
  if (!models.length) throw new Error('O provider não retornou modelos utilizáveis.');
  if (!config.selectedModel && models[0]) config.selectedModel = models[0].id;
  if (existing) providerConfigs = providerConfigs.map((item) => item.id === input.providerId ? config : item); else providerConfigs.push(config);
  await saveProviders();
  return { providers: publicProviders(), models };
});
ipcMain.handle('providers:remove', async (_event, providerId: ProviderId) => { providerConfigs = providerConfigs.filter((item) => item.id !== providerId); delete providerKeys[providerId]; modelResolver.invalidate(providerId); await saveProviders(); return publicProviders(); });
ipcMain.handle('chat:create', async (_event, input: { providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel; projectId?: string }) => chatManager.create(input));
ipcMain.handle('chat:update-settings', async (_event, input: { chatId: string; providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel }) => {
  const chat = (await chatManager.list()).find((item) => item.id === input.chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  const updated: ChatRecord = { ...chat, providerId: input.providerId, model: input.model, intelligence: input.intelligence, permissionLevel: input.permissionLevel };
  await chatManager.update(updated); return updated;
});

async function getChatContext(chatId: string): Promise<{ chat: ChatRecord; config: AIProviderConfig; projectContext?: string }> {
  const chat = (await chatManager.list()).find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  const config = providerConfigs.find((item) => item.id === chat.providerId);
  if (!config?.apiKey) throw new Error('A IA deste chat não possui uma API key configurada.');
  const projectContext = chat.projectId ? await projectContextRuntime.build(chat.projectId) : undefined;
  return { chat, config, projectContext };
}

ipcMain.handle('chat:send', async (_event, input: { chatId: string; content: string }) => {
  const { chat, config, projectContext } = await getChatContext(input.chatId);
  const content = input.content.trim();
  if (!content) throw new Error('A mensagem não pode estar vazia.');
  await chatManager.addMessage(chat.id, { role: 'user', content });
  const current = (await chatManager.list()).find((item) => item.id === chat.id)!;
  const result = await agentRuntime.run(config, current, projectContext, current.permissionLevel);
  await chatManager.update({ ...current, messages: result.messages });
  return { response: result.response, pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
});

ipcMain.handle('chat:stream', async (_event, input: { chatId: string; content: string }) => {
  const { chat, config, projectContext } = await getChatContext(input.chatId);
  const content = input.content.trim();
  if (!content) throw new Error('A mensagem não pode estar vazia.');
  await chatManager.addMessage(chat.id, { role: 'user', content });
  const current = (await chatManager.list()).find((item) => item.id === chat.id)!;
  const models = await modelResolver.list(config);
  const model = modelResolver.find(models, current.model);
  const supportsTools = model.capabilities.includes('tools');

  if (supportsTools) {
    const result = await agentRuntime.run(config, current, projectContext, current.permissionLevel);
    mainWindow?.webContents.send('chat:stream-event', { type: 'start' } satisfies AIStreamEvent);
    if (result.response.content) mainWindow?.webContents.send('chat:stream-event', { type: 'delta', text: result.response.content } satisfies AIStreamEvent);
    mainWindow?.webContents.send('chat:stream-event', { type: 'complete', response: result.response, usage: result.response.usage } satisfies AIStreamEvent);
    await chatManager.update({ ...current, messages: result.messages });
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
  }

  let finalResponse: AIStreamEvent['response'];
  let streamedText = '';
  for await (const event of chatRuntime.stream(config, current, projectContext)) {
    if (event.type === 'delta' && event.text) streamedText += event.text;
    if (event.type === 'complete' && event.response) finalResponse = event.response;
    mainWindow?.webContents.send('chat:stream-event', event);
  }
  if (finalResponse) await chatManager.addMessage(chat.id, { role: 'assistant', content: finalResponse.content });
  else if (streamedText) await chatManager.addMessage(chat.id, { role: 'assistant', content: streamedText });
  return { pendingApprovalIds: [], chat: (await chatManager.list()).find((item) => item.id === chat.id) };
});

ipcMain.handle('agent:list-tools', async () => toolRuntime.listDefinitions());
ipcMain.handle('agent:list-approvals', async () => toolRuntime.listApprovals());
ipcMain.handle('agent:approve', async (_event, approvalId: string) => {
  const result = await agentRuntime.resume(approvalId);
  const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
  if (chat) await chatManager.update({ ...chat, messages: result.messages });
  return result;
});
ipcMain.handle('agent:deny', async (_event, approvalId: string) => {
  const result = await agentRuntime.reject(approvalId);
  const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
  if (chat) await chatManager.update({ ...chat, messages: result.messages });
  return result;
});
ipcMain.handle('projects:create', async (_event, input: { name: string; rootPath: string }) => projectManager.create(input.name, input.rootPath));
ipcMain.handle('projects:open-folder', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); if (result.canceled || !result.filePaths[0]) return null; return result.filePaths[0]; });
ipcMain.handle('projects:scan', async (_event, rootPath: string) => projectManager.scan(rootPath));
ipcMain.handle('projects:read-file', async (_event, filePath: string) => projectManager.readFile(filePath));
ipcMain.handle('projects:write-file', async (_event, input: { filePath: string; content: string }) => projectManager.writeFile(input.filePath, input.content));
ipcMain.handle('app:open-external', async (_event, url: string) => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('URL externa inválida.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Somente URLs HTTP e HTTPS podem ser abertas.');
  await shell.openExternal(parsed.toString());
});

app.whenReady().then(async () => { await storage.init(); await loadProviders(); await projectManager.init(); await chatManager.init(); await createWindow(); app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });