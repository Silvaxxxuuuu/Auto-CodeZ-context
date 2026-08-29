import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('autoCodez', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  listModels: (providerId: string) => ipcRenderer.invoke('providers:list-models', providerId),
  saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => ipcRenderer.invoke('providers:save', input),
  removeProvider: (providerId: string) => ipcRenderer.invoke('providers:remove', providerId),
  createChat: (input: { providerId: string; model: string; intelligence: string; permissionLevel: string; projectId?: string }) => ipcRenderer.invoke('chat:create', input),
  updateChatSettings: (input: { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }) => ipcRenderer.invoke('chat:update-settings', input),
  sendChat: (input: { chatId: string; content: string }) => ipcRenderer.invoke('chat:send', input),
  createProject: (input: { name: string; rootPath: string }) => ipcRenderer.invoke('projects:create', input),
  openFolder: () => ipcRenderer.invoke('projects:open-folder'),
  scanProject: (rootPath: string) => ipcRenderer.invoke('projects:scan', rootPath),
  readFile: (filePath: string) => ipcRenderer.invoke('projects:read-file', filePath),
  writeFile: (input: { filePath: string; content: string }) => ipcRenderer.invoke('projects:write-file', input),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
});
