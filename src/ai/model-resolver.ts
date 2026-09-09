import crypto from 'node:crypto';
import type { AIModel, AIProviderConfig, Capability, ProviderId } from './types';
import { ProviderRegistry } from './provider-registry';
import { selectDefaultModel } from './model-selection';

const UNCONFIGURED_MODEL_IDS = new Set(['unconfigured', 'Unconfigured']);
const DEFAULT_FALLBACK_CAPABILITIES: Capability[] = ['text', 'streaming', 'tools'];
const REQUEST_DISCOVERY_BUDGET_MS = 750;

export class ModelResolver {
  private readonly cache = new Map<string, { models: AIModel[]; fetchedAt: number }>();
  private readonly inFlight = new Map<string, Promise<AIModel[]>>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(private readonly registry: ProviderRegistry) {}

  private cacheKey(config: AIProviderConfig): string {
    const credentialFingerprint = crypto.createHash('sha256').update(config.apiKey).digest('hex');
    return `${config.id}\u0000${config.baseUrl ?? ''}\u0000${credentialFingerprint}`;
  }

  async list(config: AIProviderConfig, forceRefresh = false): Promise<AIModel[]> {
    const key = this.cacheKey(config);
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < this.ttlMs) return [...cached.models];
    if (!forceRefresh) {
      const pending = this.inFlight.get(key);
      if (pending) return [...await pending];
    }

    const task = this.registry.listModels(config)
      .then((models) => {
        this.cache.set(key, { models: [...models], fetchedAt: Date.now() });
        return [...models];
      })
      .catch((error) => {
        if (cached?.models.length) return [...cached.models];
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
      });

    if (!forceRefresh) this.inFlight.set(key, task);
    return [...await task];
  }

  async resolveForRequest(config: AIProviderConfig, modelId: string, discoveryBudgetMs = REQUEST_DISCOVERY_BUDGET_MS): Promise<AIModel> {
    if (!modelId.trim() || UNCONFIGURED_MODEL_IDS.has(modelId)) {
      const models = await this.list(config);
      return this.find(models, modelId, config.id);
    }

    const cached = this.cache.get(this.cacheKey(config))?.models.find((model) => model.id === modelId);
    if (cached) return { ...cached, capabilities: [...cached.capabilities], reasoningLevels: [...cached.reasoningLevels] };

    const discovery = this.list(config);
    if (discoveryBudgetMs <= 0) {
      void discovery.catch((): undefined => undefined);
      return this.fallbackForConfiguredModel(config, modelId);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race<AIModel[] | undefined>([
        discovery,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), discoveryBudgetMs);
        }),
      ]);
      if (result) return this.find(result, modelId, config.id);
    } catch {
      return this.fallbackForConfiguredModel(config, modelId);
    } finally {
      if (timer) clearTimeout(timer);
    }

    void discovery.catch((): undefined => undefined);
    return this.fallbackForConfiguredModel(config, modelId);
  }

  invalidate(providerId?: ProviderId): void {
    if (!providerId) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    const prefix = `${providerId}\u0000`;
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
    for (const key of this.inFlight.keys()) if (key.startsWith(prefix)) this.inFlight.delete(key);
  }

  find(models: AIModel[], modelId: string, providerId?: ProviderId): AIModel {
    if (UNCONFIGURED_MODEL_IDS.has(modelId)) {
      const fallbackId = selectDefaultModel(providerId || models[0]?.providerId || 'unknown', models);
      const fallback = fallbackId ? models.find((model) => model.id === fallbackId) : undefined;
      if (fallback) return fallback;
    }
    const model = models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Modelo '${modelId}' não está disponível.`);
    return model;
  }

  fallbackForConfiguredModel(config: AIProviderConfig, modelId: string): AIModel {
    if (!modelId.trim() || UNCONFIGURED_MODEL_IDS.has(modelId)) throw new Error('Nenhum modelo foi configurado para este chat.');
    const cached = this.cache.get(this.cacheKey(config))?.models.find((model) => model.id === modelId);
    if (cached) return { ...cached, capabilities: [...cached.capabilities], reasoningLevels: [...cached.reasoningLevels] };
    const adapter = this.registry.get(config.id);
    const capabilities = adapter.fallbackCapabilities?.length ? [...adapter.fallbackCapabilities] : [...DEFAULT_FALLBACK_CAPABILITIES];
    return {
      id: modelId,
      name: modelId,
      providerId: config.id,
      capabilities,
      reasoningLevels: ['normal'],
    };
  }
}
