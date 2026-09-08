import type { AIModel, AIProviderAdapter, AIProviderConfig, ProviderId, ProviderSummary } from './types';
import { createOpenAICompatibleProviderAdapters } from './providers/openai-compatible';
import { createExpandedProviderAdapters } from './providers/provider-expansion';
import { OllamaAdapter } from './providers/ollama';

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, AIProviderAdapter>();

  constructor() {
    for (const adapter of createOpenAICompatibleProviderAdapters()) this.register(adapter);
    for (const adapter of createExpandedProviderAdapters()) this.register(adapter);
    this.register(new OllamaAdapter());
  }

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
      const requiresApiKey = adapter.requiresApiKey !== false;
      const apiKeyConfigured = Boolean(config?.apiKey);
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        configured: requiresApiKey ? Boolean(config?.enabled && apiKeyConfigured) : config?.enabled !== false,
        apiKeyConfigured,
        requiresApiKey,
        selectedModel: config?.selectedModel,
      };
    });
  }
}
