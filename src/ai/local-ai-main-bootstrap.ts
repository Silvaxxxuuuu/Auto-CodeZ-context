import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { collectLocalHardwareSnapshot } from './local-hardware';
import { getLocalModelCatalogEntry, listLocalModelCatalog } from './local-model-catalog';
import { LocalModelManager, type ManagedLocalModel } from './local-model-manager';
import type { LocalModelInstallProgress } from './local-model-runtime';
import { LMStudioLocalRuntimeAdapter } from './local-runtimes/lm-studio';
import { OllamaLocalRuntimeAdapter } from './local-runtimes/ollama';
import { requireIdentifier, requireObject } from '../core/input-validation';

const manager = new LocalModelManager([
  new OllamaLocalRuntimeAdapter(),
  new LMStudioLocalRuntimeAdapter({ apiToken: process.env.LM_API_TOKEN }),
]);

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

async function buildSnapshot() {
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

ipcMain.handle('local-ai:install', async (_event, input: unknown) => {
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

  const handle = manager.beginInstall(runtimeId, modelId);
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
    }
  })();

  return { started: true, installId: handle.id, compatibility };
});

ipcMain.handle('local-ai:cancel-install', async (_event, input: unknown) => {
  const value = requireObject(input, 'Cancelamento de instalação local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const modelId = requireIdentifier(value.modelId, 'Modelo local');
  return { cancelled: manager.cancelInstall(runtimeId, modelId) };
});

ipcMain.handle('local-ai:remove', async (_event, input: unknown) => {
  const value = requireObject(input, 'Remoção de modelo local');
  const runtimeId = requireIdentifier(value.runtimeId, 'Runtime local');
  const modelId = requireIdentifier(value.modelId, 'Modelo local');
  const runtime = await manager.getRuntimeInfo(runtimeId);
  if (!runtime.available) throw new Error(`${runtime.displayName} não está disponível neste computador.`);
  await manager.removeInstalled(runtimeId, modelId);
  return { removed: true };
});
