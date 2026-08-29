import { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import started from 'electron-squirrel-startup';
import { ProviderRegistry } from './ai/provider-registry';
import { AIRuntime } from './ai/ai-runtime';
import { OpenAIAdapter } from './ai/providers/openai';
import { GoogleAdapter } from './ai/providers/google';
import { AnthropicAdapter } from './ai/providers/anthropic';
import type { AIProviderConfig, ChatRecord, IntelligenceLevel, PermissionLevel, ProviderId } from './ai/types';
import { LocalStorage } from './core/storage';
import { ProjectManager } from './core/project-manager';
import { ChatManager } from './core/chat-manager';

if (started) app.quit();

const storage = new LocalStorage();
const registry = new ProviderRegistry();
registry.register(new OpenAIAdapter());
registry.register(new GoogleAdapter());
registry.register(new AnthropicAdapter());
const aiRuntime = new AIRuntime(registry);
const projectManager = new ProjectManager(storage);
const chatManager = new ChatManager(storage);

let providerConfigs: AIProviderConfig[] = [];
let providerKeys: Record<string, string> = {};

const defaultProviders: AIProviderConfig[] = [
  { id: 'openai', displayName: 'OpenAI', apiKey: '', enabled: false },
  { id: 'google', displayName: 'Google AI', apiKey: '', enabled: false },
  { id: 'anthropic', displayName: 'Anthropic', apiKey: '', enabled: false },
];

async function loadProviders(): Promise<void> {
  providerConfigs = await storage.read<AIProviderConfig[]>('providers.json', defaultProviders);
  providerKeys = JSON.parse((await storage.readEncrypted('provider-keys.dat')) || '{}') as Record<string, string>;
  providerConfigs = providerConfigs.map((config) => ({ ...config, apiKey: providerKeys[config.id] || '' }));
}

async function saveProviders(): Promise<void> {
  providerKeys = {};
  for (const config of providerConfigs) {
    if (config.apiKey) providerKeys[config.id] = config.apiKey;
  }
  await storage.write('providers.json', providerConfigs.map(({ apiKey: _apiKey, ...config }) => config));
  await storage.writeEncrypted('provider-keys.dat', JSON.stringify(providerKeys));
}

function publicProviders() {
  return registry.summaries(providerConfigs).map((summary) => ({
    ...summary,
    apiKeyConfigured: Boolean(providerKeys[summary.id]),
  }));
}

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#090b0f',
    title: 'Auto CodeZ',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

ipcMain.handle('app:get-state', async () => ({
  providers: publicProviders(),
  chats: await chatManager.list(),
  projects: await projectManager.list(),
}));

ipcMain.handle('providers:list-models', async (_event, providerId: ProviderId) => {
  const config = providerConfigs.find((item) => item.id === providerId);
  if (!config?.apiKey) throw new Error('Configure a API key primeiro.');
  const models = await registry.listModels(config);
  return models;
});

ipcMain.handle('providers:save', async (_event, input: { providerId: ProviderId; apiKey: string; model?: string; baseUrl?: string }) => {
  const adapter = registry.get(input.providerId);
  const existing = providerConfigs.find((item) => item.id === input.providerId);
  const config: AIProviderConfig = {
    id: input.providerId,
    displayName: adapter.displayName,
    apiKey: input.apiKey.trim(),
    enabled: true,
    selectedModel: input.model,
    baseUrl: input.baseUrl?.trim() || undefined,
  };
  if (existing) providerConfigs = providerConfigs.map((item) => item.id === input.providerId ? config : item);
  else providerConfigs.push(config);
  await saveProviders();
  const models = await registry.listModels(config);
  if (!config.selectedModel && models[0]) {
    config.selectedModel = models[0].id;
    await saveProviders();
  }
  return { providers: publicProviders(), models };
});

ipcMain.handle('providers:remove', async (_event, providerId: ProviderId) => {
  providerConfigs = providerConfigs.filter((item) => item.id !== providerId);
  delete providerKeys[providerId];
  await saveProviders();
  return publicProviders();
});

ipcMain.handle('chat:create', async (_event, input: { providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel; projectId?: string }) => {
  return chatManager.create(input);
});

ipcMain.handle('chat:update-settings', async (_event, input: { chatId: string; providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel }) => {
  const chats = await chatManager.list();
  const chat = chats.find((item) => item.id === input.chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  const updated: ChatRecord = { ...chat, providerId: input.providerId, model: input.model, intelligence: input.intelligence, permissionLevel: input.permissionLevel };
  await chatManager.update(updated);
  return updated;
});

ipcMain.handle('chat:send', async (_event, input: { chatId: string; content: string }) => {
  const chats = await chatManager.list();
  const chat = chats.find((item) => item.id === input.chatId);
  if (!chat) throw new Error('Chat não encontrado.');
  const config = providerConfigs.find((item) => item.id === chat.providerId);
  if (!config?.apiKey) throw new Error('A IA deste chat não possui uma API key configurada.');

  await chatManager.addMessage(chat.id, { role: 'user', content: input.content });
  const updated = await chatManager.list();
  const current = updated.find((item) => item.id === chat.id)!;
  const response = await aiRuntime.send(config, current.messages, chat.model, chat.intelligence);
  await chatManager.addMessage(chat.id, { role: 'assistant', content: response.content });
  return { response, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
});

ipcMain.handle('projects:create', async (_event, input: { name: string; rootPath: string }) => projectManager.create(input.name, input.rootPath));

ipcMain.handle('projects:open-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('projects:scan', async (_event, rootPath: string) => projectManager.scan(rootPath));
ipcMain.handle('projects:read-file', async (_event, filePath: string) => projectManager.readFile(filePath));
ipcMain.handle('projects:write-file', async (_event, input: { filePath: string; content: string }) => projectManager.writeFile(input.filePath, input.content));
ipcMain.handle('app:open-external', async (_event, url: string) => shell.openExternal(url));

app.whenReady().then(async () => {
  await storage.init();
  await loadProviders();
  await projectManager.init();
  await chatManager.init();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
