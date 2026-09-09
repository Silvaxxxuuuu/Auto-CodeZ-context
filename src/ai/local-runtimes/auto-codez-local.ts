import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AutoCodezLocalEngineManager, type AutoCodezLocalEngineOptions } from '../auto-codez-local-engine';
import type {
  LocalModelDescriptor,
  LocalModelInstallProgress,
  LocalModelInstallRequest,
  LocalModelRuntimeAdapter,
  LocalModelRuntimeInfo,
} from '../local-model-runtime';
import { downloadVerifiedFile, type VerifiedDownloadProgress } from '../verified-download';

export type AutoCodezLocalRuntimeOptions = AutoCodezLocalEngineOptions & {
  modelFetcher?: typeof fetch;
};

type InstalledModelManifest = {
  descriptor: Omit<LocalModelDescriptor, 'installed' | 'runtimeId'>;
  fileName: string;
  sha256: string;
  installedAt: number;
};

function safeKey(modelId: string): string {
  return crypto.createHash('sha256').update(modelId).digest('hex').slice(0, 24);
}

function requireInstallRequest(model: string | LocalModelInstallRequest): LocalModelInstallRequest & {
  source: string;
  fileName: string;
  sha256: string;
  expectedBytes: number;
} {
  if (typeof model === 'string') throw new Error('Auto CodeZ Local exige um artefato verificado do catálogo confiável.');
  const source = model.source?.trim();
  const fileName = model.fileName?.trim();
  const sha256 = model.sha256?.trim();
  const expectedBytes = model.expectedBytes;
  if (!source || !/^https:\/\//i.test(source)) throw new Error('URL verificada do modelo local ausente.');
  if (!fileName || !/^[a-z0-9._-]+\.gguf$/i.test(fileName)) throw new Error('Nome de arquivo GGUF inválido.');
  if (!sha256 || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(sha256)) throw new Error('SHA-256 do modelo local ausente ou inválido.');
  if (!expectedBytes || !Number.isFinite(expectedBytes) || expectedBytes <= 0) throw new Error('Tamanho esperado do GGUF inválido.');
  return { ...model, source, fileName, sha256, expectedBytes };
}

async function* progressFromTask(
  runtimeId: string,
  modelId: string,
  status: string,
  task: (onProgress: (progress: VerifiedDownloadProgress) => void) => Promise<void>,
): AsyncGenerator<LocalModelInstallProgress> {
  const queue: VerifiedDownloadProgress[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;
  void task((progress) => {
    queue.push(progress);
    wake?.();
    wake = undefined;
  }).catch((error) => {
    failure = error;
  }).finally(() => {
    finished = true;
    wake?.();
    wake = undefined;
  });

  while (!finished || queue.length) {
    while (queue.length) {
      const progress = queue.shift()!;
      yield {
        runtimeId,
        modelId,
        status,
        completedBytes: progress.completedBytes,
        totalBytes: progress.totalBytes,
        percent: progress.percent,
        done: false,
      };
    }
    if (!finished) await new Promise<void>((resolve) => { wake = resolve; });
  }
  if (failure) throw failure;
}

export class AutoCodezLocalRuntimeAdapter implements LocalModelRuntimeAdapter {
  readonly id = 'auto-codez-local';
  readonly displayName = 'Auto CodeZ Local';
  readonly supportsInstallCancellation = true;
  readonly engine: AutoCodezLocalEngineManager;
  private readonly modelFetcher?: typeof fetch;

  constructor(readonly rootDir: string, options: AutoCodezLocalRuntimeOptions = {}) {
    this.engine = new AutoCodezLocalEngineManager(rootDir, options);
    this.modelFetcher = options.modelFetcher ?? options.fetcher;
  }

  private modelsDir(): string {
    return path.join(this.rootDir, 'models');
  }

  private manifestPath(modelId: string): string {
    return path.join(this.modelsDir(), `${safeKey(modelId)}.json`);
  }

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: this.engine.isSupported(),
      endpoint: 'managed://auto-codez-local',
    };
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    const files = await fs.readdir(this.modelsDir()).catch(() => [] as string[]);
    const descriptors: LocalModelDescriptor[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.modelsDir(), file), 'utf8');
        const manifest = JSON.parse(raw) as InstalledModelManifest;
        if (!manifest?.descriptor?.id || !manifest.fileName || !manifest.sha256) continue;
        const modelPath = path.join(this.modelsDir(), manifest.fileName);
        const stat = await fs.stat(modelPath);
        if (!stat.isFile()) continue;
        descriptors.push({
          ...manifest.descriptor,
          runtimeId: this.id,
          installed: true,
          sizeBytes: stat.size,
          capabilities: [...(manifest.descriptor.capabilities ?? [])],
        });
      } catch {
        // A damaged or partial manifest is ignored; it is never exposed as installed.
      }
    }
    return descriptors;
  }

  async modelPath(modelId: string): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.manifestPath(modelId), 'utf8');
      const manifest = JSON.parse(raw) as InstalledModelManifest;
      if (manifest.descriptor.id !== modelId) return undefined;
      const candidate = path.join(this.modelsDir(), manifest.fileName);
      const stat = await fs.stat(candidate);
      return stat.isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  async *install(model: string | LocalModelInstallRequest, signal?: AbortSignal): AsyncGenerator<LocalModelInstallProgress> {
    const request = requireInstallRequest(model);
    if (!this.engine.isSupported()) throw new Error('Auto CodeZ Local ainda suporta somente Windows x64 nesta versão.');

    if (!await this.engine.isInstalled()) {
      yield* progressFromTask(this.id, request.modelId, 'Preparando mecanismo local', async (onProgress) => {
        await this.engine.ensureInstalled(signal, onProgress);
      });
    }

    const destination = path.join(this.modelsDir(), request.fileName);
    yield* progressFromTask(this.id, request.modelId, 'Baixando modelo verificado', async (onProgress) => {
      await downloadVerifiedFile({
        url: request.source,
        destination,
        sha256: request.sha256,
        expectedBytes: request.expectedBytes,
        maximumBytes: Math.ceil(request.expectedBytes * 1.02),
      }, { signal, fetcher: this.modelFetcher, onProgress });
    });

    const descriptor: Omit<LocalModelDescriptor, 'installed' | 'runtimeId'> = {
      id: request.modelId,
      name: request.modelId,
      sizeBytes: request.expectedBytes,
      ...(request.quantization ? { quantization: request.quantization } : {}),
    };
    const manifest: InstalledModelManifest = {
      descriptor,
      fileName: request.fileName,
      sha256: request.sha256.replace(/^sha256:/i, '').toLowerCase(),
      installedAt: Date.now(),
    };
    await fs.mkdir(this.modelsDir(), { recursive: true });
    await fs.writeFile(this.manifestPath(request.modelId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    yield {
      runtimeId: this.id,
      modelId: request.modelId,
      status: 'Modelo local pronto',
      completedBytes: request.expectedBytes,
      totalBytes: request.expectedBytes,
      percent: 100,
      digest: manifest.sha256,
      done: true,
    };
  }

  async remove(modelId: string): Promise<void> {
    try {
      const raw = await fs.readFile(this.manifestPath(modelId), 'utf8');
      const manifest = JSON.parse(raw) as InstalledModelManifest;
      if (manifest.fileName) await fs.rm(path.join(this.modelsDir(), manifest.fileName), { force: true });
    } catch {
      // Removing an already missing model is idempotent.
    }
    await fs.rm(this.manifestPath(modelId), { force: true });
  }
}
