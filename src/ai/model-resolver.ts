import type { AIModel, AIProviderConfig, ProviderId } from './types';
import { ProviderRegistry } from './provider-registry';

export class ModelResolver {
  private readonly cache = new Map<ProviderId, { models: AIModel[]; fetchedAt: number }>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(private readonly registry: ProviderRegistry) {}

  async list(config: AIProviderConfig, forceRefresh = false): Promise<AIModel[]> {
    const cached = this.cache.get(config.id);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < this.ttlMs) return [...cached.models];
    const models = await this.registry.listModels(config);
    this.cache.set(config.id, { models, fetchedAt: Date.now() });
    return [...models];
  }

  invalidate(providerId?: ProviderId): void {
    if (providerId) this.cache.delete(providerId);
    else this.cache.clear();
  }

  find(models: AIModel[], modelId: string): AIModel {
    const model = models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Modelo '${modelId}' não está disponível.`);
    return model;
  }
}
