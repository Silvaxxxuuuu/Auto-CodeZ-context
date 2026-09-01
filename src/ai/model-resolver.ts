import type { AIModel, AIProviderConfig, ProviderId } from './types';
import { ProviderRegistry } from './provider-registry';
import { selectDefaultModel } from './model-selection';

const UNCONFIGURED_MODEL_IDS = new Set(['unconfigured', 'Unconfigured']);

export class ModelResolver {
  private readonly cache = new Map<ProviderId, { models: AIModel[]; fetchedAt: number }>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(private readonly registry: ProviderRegistry) {}

  async list(config: AIProviderConfig, forceRefresh = false): Promise<AIModel[]> {
    const cached = this.cache.get(config.id);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < this.ttlMs) return [...cached.models];
    try {
      const models = await this.registry.listModels(config);
      this.cache.set(config.id, { models, fetchedAt: Date.now() });
      return [...models];
    } catch (error) {
      if (cached?.models.length) return [...cached.models];
      throw error;
    }
  }

  invalidate(providerId?: ProviderId): void {
    if (providerId) this.cache.delete(providerId);
    else this.cache.clear();
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
    const cached = this.cache.get(config.id)?.models.find((model) => model.id === modelId);
    if (cached) return cached;
    return {
      id: modelId,
      name: modelId,
      providerId: config.id,
      capabilities: ['text', 'streaming', 'tools'],
      reasoningLevels: ['normal'],
    };
  }
}
