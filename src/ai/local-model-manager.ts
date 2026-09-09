import {
  estimateQuantizedModelRam,
  evaluateLocalModelCompatibility,
  type LocalHardwareSnapshot,
  type LocalModelCompatibilityResult,
  type LocalModelDescriptor,
  type LocalModelInstallProgress,
  type LocalModelRequirements,
  type LocalModelRuntimeAdapter,
  type LocalModelRuntimeInfo,
} from './local-model-runtime';

export type ManagedLocalModel = LocalModelDescriptor & {
  compatibility: LocalModelCompatibilityResult;
};

export type LocalModelInstallHandle = {
  id: string;
  runtimeId: string;
  modelId: string;
  cancel: () => void;
  progress: AsyncGenerator<LocalModelInstallProgress>;
};

function installId(runtimeId: string, modelId: string): string {
  return `${runtimeId}:${modelId}`;
}

export class LocalModelManager {
  private readonly runtimes = new Map<string, LocalModelRuntimeAdapter>();
  private readonly activeInstalls = new Map<string, AbortController>();

  constructor(adapters: LocalModelRuntimeAdapter[] = []) {
    for (const adapter of adapters) this.registerRuntime(adapter);
  }

  registerRuntime(adapter: LocalModelRuntimeAdapter): void {
    if (!adapter.id.trim()) throw new Error('Runtime local sem identificador.');
    this.runtimes.set(adapter.id, adapter);
  }

  runtimeIds(): string[] {
    return [...this.runtimes.keys()];
  }

  async getRuntimeInfo(runtimeId: string): Promise<LocalModelRuntimeInfo> {
    return this.requireRuntime(runtimeId).getInfo();
  }

  async getRuntimeInfos(): Promise<LocalModelRuntimeInfo[]> {
    return Promise.all([...this.runtimes.values()].map((runtime) => runtime.getInfo()));
  }

  async listInstalled(runtimeId: string, hardware: LocalHardwareSnapshot): Promise<ManagedLocalModel[]> {
    const models = await this.requireRuntime(runtimeId).listInstalled();
    return models.map((model) => ({
      ...model,
      compatibility: this.evaluateModel(model, hardware),
    }));
  }

  evaluateModel(model: Pick<LocalModelDescriptor, 'sizeBytes'>, hardware: LocalHardwareSnapshot): LocalModelCompatibilityResult {
    const estimatedRamBytes = estimateQuantizedModelRam(model.sizeBytes);
    const requirements: LocalModelRequirements = {
      ...(model.sizeBytes ? { downloadBytes: model.sizeBytes } : {}),
      ...(estimatedRamBytes ? { estimatedRamBytes } : {}),
    };
    return evaluateLocalModelCompatibility(hardware, requirements);
  }

  beginInstall(runtimeId: string, modelId: string): LocalModelInstallHandle {
    const runtime = this.requireRuntime(runtimeId);
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) throw new Error('Modelo local inválido.');
    const id = installId(runtimeId, normalizedModelId);
    if (this.activeInstalls.has(id)) throw new Error('Este modelo já está sendo instalado.');

    const controller = new AbortController();
    this.activeInstalls.set(id, controller);
    const source = runtime.install(normalizedModelId, controller.signal);
    const cleanup = () => this.activeInstalls.delete(id);

    async function* progress(): AsyncGenerator<LocalModelInstallProgress> {
      try {
        for await (const item of source) yield item;
      } finally {
        cleanup();
      }
    }

    return {
      id,
      runtimeId,
      modelId: normalizedModelId,
      cancel: () => controller.abort(),
      progress: progress(),
    };
  }

  cancelInstall(runtimeId: string, modelId: string): boolean {
    const controller = this.activeInstalls.get(installId(runtimeId, modelId.trim()));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isInstalling(runtimeId: string, modelId: string): boolean {
    return this.activeInstalls.has(installId(runtimeId, modelId.trim()));
  }

  private requireRuntime(runtimeId: string): LocalModelRuntimeAdapter {
    const runtime = this.runtimes.get(runtimeId.trim());
    if (!runtime) throw new Error(`Runtime local não registrado: ${runtimeId}`);
    return runtime;
  }
}
