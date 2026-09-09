import {
  estimateQuantizedModelRam,
  evaluateLocalModelCompatibility,
  type LocalHardwareSnapshot,
  type LocalModelCompatibility,
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

export type LocalModelRecommendation = {
  runtimeId: string;
  modelId: string;
  compatibility: LocalModelCompatibilityResult;
  reason: string;
};

export type LocalModelEvaluationOptions = {
  includeDownload?: boolean;
};

type RecommendationCandidate = Pick<LocalModelDescriptor, 'id' | 'runtimeId' | 'sizeBytes' | 'capabilities'>;

type RankedRecommendationCandidate = {
  model: RecommendationCandidate;
  compatibility: LocalModelCompatibilityResult;
};

function installId(runtimeId: string, modelId: string): string {
  return `${runtimeId}:${modelId}`;
}

function compatibilityRank(level: LocalModelCompatibility): number {
  if (level === 'excellent') return 3;
  if (level === 'compatible') return 2;
  if (level === 'limit') return 1;
  return 0;
}

function capabilityRank(capabilities: string[] | undefined): number {
  const values = new Set(capabilities ?? []);
  return (values.has('tools') ? 2 : 0) + (values.has('reasoning') ? 1 : 0);
}

function supportsAgentTools(model: RecommendationCandidate): boolean {
  return model.capabilities?.includes('tools') === true;
}

function isSafeRecommendation(entry: RankedRecommendationCandidate): boolean {
  return entry.compatibility.level === 'excellent' || entry.compatibility.level === 'compatible';
}

function sortRecommendationCandidates(entries: RankedRecommendationCandidate[]): RankedRecommendationCandidate[] {
  return entries.sort((left, right) => {
    const compatibilityDifference = compatibilityRank(right.compatibility.level) - compatibilityRank(left.compatibility.level);
    if (compatibilityDifference) return compatibilityDifference;
    const capabilityDifference = capabilityRank(right.model.capabilities) - capabilityRank(left.model.capabilities);
    if (capabilityDifference) return capabilityDifference;
    const sizeDifference = (right.model.sizeBytes ?? 0) - (left.model.sizeBytes ?? 0);
    if (sizeDifference) return sizeDifference;
    return left.model.id.localeCompare(right.model.id);
  });
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
      compatibility: this.evaluateModel(model, hardware, { includeDownload: false }),
    }));
  }

  evaluateModel(
    model: Pick<LocalModelDescriptor, 'sizeBytes'>,
    hardware: LocalHardwareSnapshot,
    options: LocalModelEvaluationOptions = {},
  ): LocalModelCompatibilityResult {
    const estimatedRamBytes = estimateQuantizedModelRam(model.sizeBytes);
    const includeDownload = options.includeDownload !== false;
    const requirements: LocalModelRequirements = {
      ...(includeDownload && model.sizeBytes ? { downloadBytes: model.sizeBytes } : {}),
      ...(estimatedRamBytes ? { estimatedRamBytes } : {}),
    };
    return evaluateLocalModelCompatibility(hardware, requirements);
  }

  recommendModel(models: RecommendationCandidate[], hardware: LocalHardwareSnapshot): LocalModelRecommendation | undefined {
    const viable = models
      .map((model): RankedRecommendationCandidate => ({ model, compatibility: this.evaluateModel(model, hardware) }))
      .filter((entry) => entry.compatibility.level !== 'blocked');

    const safe = viable.filter(isSafeRecommendation);
    const safeAgentModels = safe.filter((entry) => supportsAgentTools(entry.model));
    const pool = safeAgentModels.length > 0
      ? safeAgentModels
      : safe.length > 0
        ? safe
        : viable;
    const selected = sortRecommendationCandidates(pool)[0];
    if (!selected) return undefined;

    const agentReady = supportsAgentTools(selected.model);
    const reason = selected.compatibility.level === 'limit'
      ? agentReady
        ? 'É a única opção de agente viável encontrada, mas o uso atual de memória deixa pouca margem.'
        : 'É a única opção local viável encontrada, mas o uso atual de memória deixa pouca margem e ela não oferece tools para o agente.'
      : agentReady
        ? selected.compatibility.level === 'excellent'
          ? 'Melhor equilíbrio entre recursos de agente e margem confortável de hardware.'
          : 'Melhor opção de agente que permanece compatível com o hardware detectado.'
        : 'Melhor opção local segura disponível neste catálogo, mas sem suporte de tools para o agente.';

    return {
      runtimeId: selected.model.runtimeId,
      modelId: selected.model.id,
      compatibility: selected.compatibility,
      reason,
    };
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

  async removeInstalled(runtimeId: string, modelId: string): Promise<void> {
    const runtime = this.requireRuntime(runtimeId);
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) throw new Error('Modelo local inválido.');
    if (this.isInstalling(runtimeId, normalizedModelId)) throw new Error('Cancele a instalação antes de remover este modelo.');
    if (!runtime.remove) throw new Error(`${runtime.displayName} não oferece remoção de modelos pelo Auto CodeZ.`);
    const installed = await runtime.listInstalled();
    if (!installed.some((model) => model.id === normalizedModelId)) throw new Error('O modelo local não está instalado neste runtime.');
    await runtime.remove(normalizedModelId);
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
