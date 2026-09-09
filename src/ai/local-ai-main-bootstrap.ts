import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { LocalStorage } from '../core/storage';
import { requireIdentifier, requireNonEmptyString, requireObject } from '../core/input-validation';
import { collectLocalHardwareSnapshot } from './local-hardware';
import { getLocalModelCatalogEntry, listLocalModelCatalog } from './local-model-catalog';
import { LocalModelManager, type ManagedLocalModel } from './local-model-manager';
import type { LocalModelInstallProgress } from './local-model-runtime';
import {
  getLocalRuntimeConnection,
  LocalRuntimeSettingsStore,
  registerLocalRuntimeSettingsInitialization,
  waitForLocalRuntimeSettingsInitialization,
  type LocalRuntimeSettingsStorage,
} from './local-runtime-settings';
import { LMStudioLocalRuntimeAdapter } from './local-runtimes/lm-studio';
import { OllamaLocalRuntimeAdapter } from './local-runtimes/ollama';

function createManager(): LocalModelManager {
  const ollama = getLocalRuntimeConnection('ollama');
  const lmStudio = getLocalRuntimeConnection('lm-studio');
  return new LocalModelManager([
    new OllamaLocalRuntimeAdapter(ollama.endpoint),
    new LMStudioLocalRuntimeAdapter({ endpoint: lmStudio.endpoint, apiToken: lmStudio.apiToken }),
  ]);
}

let manager = createManager();
let runtimeSettingsStore: LocalRuntimeSettingsStore | undefined;
let settingsUpdateInProgress = false;
let activeRuntimeMutations = 0;

type LocalAiInstallEvent = {
  type: 'progress' | 'complete' | 'cancelled' | 'error';
  runtimeId: string;
  modelId: string;
  progress?: LocalModelInstallProgress;
  error?: string;
};

function broadcastInstallEvent(event: LocalAiInstallEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('local-ai:install-event', event);
  }
}

function hardwareProbePath(): string {
  const customOllamaModels = process.env.OLLAMA_MODELS?.trim();
  if (customOllamaModels) return path.resolve(customOllamaModels);
  return app.getPath('home');
}

function requireRuntimeSettings(): LocalRuntimeSettingsStore {
  if (!runtimeSettingsStore) throw new Error('Configuração dos runtimes locais ainda não foi inicializada.');
  return runtimeSettingsStore;
}

function ensureRuntimeMutationAllowed(): void {
  if (settingsUpdateInProgress) throw new Error('Aguarde a atualização da configuração do runtime local.');
}

export async function initializeLocalAiRuntimeSettings(storage: LocalRuntimeSettingsStorage): Promise<void> {
  const store = new LocalRuntimeSettingsStore(storage);
  await store.init();
  runtimeSettingsStore = store;
  manager = createManager();
}

const runtimeSettingsStorage = new LocalStorage();
const runtimeSettingsInitialization = app.whenReady().then(async () => {
  await runtimeSettingsStorage.init();
  await initializeLocalAiRuntimeSettings(runtimeSettingsStorage);
});
registerLocalRuntimeSettingsInitialization(runtimeSettingsInitialization);
void runtimeSettingsInitialization.catch(() => undefined);

async function buildSnapshot() {
  await waitForLocalRuntimeSettingsInitialization();
  const hardware = await collectLocalHardwareSnapshot(hardwareProbePath());
  const runtimes = await manager.getRuntimeInfos();
  const installed: ManagedLocalModel[] = [];
  for (const runtime of runtimes) {
    if (!runtime.available) continue;
    try {
      installed.push(...await manager.listInstalled(runtime.id, hardware));
    } catch {
      // Runtime availability and model inventory are reported separately.
    }
  }
  const catalogModels = listLocalModelCatalog();
  const recommendation = manager.recommendModel(catalogModels, hardware);
  const catalog = catalogModels.map((model) => ({
    ...model,
    compatibility: manager.evaluateModel(model, hardware),
    installed: installed.some((item) => item.runtimeId === model.runtimeId && item.id === model.id),
    installing: manager.isInstalling(model.runtimeId, model.id),
    recommended: recommendation?.runtimeId === model.runtimeId && recommendation.modelId === model.id,
  }));
  return { hardware, runtimes, installed, catalog, recommendation };
}

ipcMain.handle('local-ai:snapshot', async () => buildSnapshot());
ipcMain.handle('local-ai:list-settings', async () => {
  await waitForLocalRuntimeSettingsInitialization();
  return requireRuntimeSettings().list();
});

ipcMain.handle('local-ai:save-settings', async (_event, input: unknown) => {
  await waitForLocalRuntimeSettingsInitialization();
  const value = requireObject(input, 'Configuração do runtime local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const endpoint = requireNonEmptyString(value.endpoint, 'Endpoint local');
  if (value.apiToken !== undefined && typeof value.apiToken !== 'string') throw new Error('Token local inválido.');
  if (value.clearToken !== undefined && typeof value.clearToken !== 'boolean') throw new Error('Opção de limpeza do token local inválida.');
  if (settingsUpdateInProgress) throw new Error('A configuração do runtime local já está sendo atualizada.');
  if (activeRuntimeMutations > 0) throw new Error('Aguarde a operação de modelo local terminar antes de alterar o runtime.');

  settingsUpdateInProgress = true;
  try {
    const apiToken = typeof value.apiToken === 'string' && value.apiToken.trim() ? value.apiToken : undefined;
    const saved = await requireRuntimeSettings().save({
      runtimeId: runtimeId as 'ollama' | 'lm-studio',
      endpoint,
      ...(apiToken ? { apiToken } : {}),
      ...(value.clearToken === true ? { clearToken: true } : {}),
    });
    manager = createManager();
    return { saved, settings: requireRuntimeSettings().list(), snapshot: await buildSnapshot() };
  } finally {
    settingsUpdateInProgress = false;
  }
});

ipcMain.handle('local-ai:install', async (_event, input: unknown) => {
  await waitForLocalRuntimeSettingsInitialization();
  ensureRuntimeMutationAllowed();
  const value = requireObject(input, 'Instalação de modelo local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const modelId = requireIdentifier(value.modelId, 'Modelo local');
  const model = getLocalModelCatalogEntry(runtimeId, modelId);
  if (!model) throw new Error('Este modelo não pertence ao catálogo local confiável do Auto CodeZ.');

  const runtime = await manager.getRuntimeInfo(runtimeId);
  if (!runtime.available) throw new Error(`${runtime.displayName} não está disponível neste computador.`);

  const hardware = await collectLocalHardwareSnapshot(hardwareProbePath());
  const compatibility = manager.evaluateModel(model, hardware);
  if (compatibility.level === 'blocked') throw new Error(compatibility.reasons[0] || 'Este modelo foi bloqueado pelo verificador de hardware.');

  ensureRuntimeMutationAllowed();
  const handle = manager.beginInstall(runtimeId, modelId);
  activeRuntimeMutations += 1;
  void (async () => {
    try {
      for await (const progress of handle.progress) {
        broadcastInstallEvent({
          type: progress.done ? 'complete' : 'progress',
          runtimeId,
          modelId,
          progress,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        broadcastInstallEvent({ type: 'cancelled', runtimeId, modelId });
        return;
      }
      broadcastInstallEvent({
        type: 'error',
        runtimeId,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      activeRuntimeMutations = Math.max(0, activeRuntimeMutations - 1);
    }
  })();

  return { started: true, installId: handle.id, compatibility };
});

ipcMain.handle('local-ai:cancel-install', async (_event, input: unknown) => {
  await waitForLocalRuntimeSettingsInitialization();
  const value = requireObject(input, 'Cancelamento de instalação local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const modelId = requireIdentifier(value.modelId, 'Modelo local');
  return { cancelled: manager.cancelInstall(runtimeId, modelId) };
});

ipcMain.handle('local-ai:remove', async (_event, input: unknown) => {
  await waitForLocalRuntimeSettingsInitialization();
  ensureRuntimeMutationAllowed();
  const value = requireObject(input, 'Remoção de modelo local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const modelId = requireIdentifier(value.modelId, 'Modelo local');
  const runtime = await manager.getRuntimeInfo(runtimeId);
  if (!runtime.available) throw new Error(`${runtime.displayName} não está disponível neste computador.`);
  ensureRuntimeMutationAllowed();
  activeRuntimeMutations += 1;
  try {
    await manager.removeInstalled(runtimeId, modelId);
  } finally {
    activeRuntimeMutations = Math.max(0, activeRuntimeMutations - 1);
  }
  return { removed: true };
});
