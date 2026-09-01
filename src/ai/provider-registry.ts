import type { AIModel, AIProviderAdapter, AIProviderConfig, ProviderId, ProviderSummary } from './types';

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, AIProviderAdapter>();

  register(adapter: AIProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(providerId: ProviderId): AIProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Provider '${providerId}' is not registered.`);
    return adapter;
  }

  list(): AIProviderAdapter[] {
    return [...this.adapters.values()];
  }

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    return this.get(config.id).listModels(config);
  }

  summaries(configs: AIProviderConfig[]): ProviderSummary[] {
    return this.list().map((adapter) => {
      const config = configs.find((item) => item.id === adapter.id);
      const apiKeyConfigured = Boolean(config?.apiKey);
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        configured: Boolean(config?.enabled && apiKeyConfigured),
        apiKeyConfigured,
        selectedModel: config?.selectedModel,
      };
    });
  }
}
