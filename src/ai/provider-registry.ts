import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AISource, AIStreamEvent, ProviderId, ProviderSummary } from './types';
import { createOpenAICompatibleProviderAdapters } from './providers/openai-compatible';
import { createExpandedProviderAdapters } from './providers/provider-expansion';
import { LMStudioProviderAdapter } from './providers/lm-studio';
import { OllamaAdapter } from './providers/ollama';
import { collectRequestSources } from './source-collector';
import { mergeAISources } from './source-normalization';

function attributeNativeSources(sources: AISource[] | undefined, providerId: ProviderId): AISource[] | undefined {
  if (!sources?.length) return sources;
  return sources.map((source) => source.origin === 'provider-native' && !source.providerId
    ? { ...source, providerId }
    : source);
}

function withCollectedSources(response: AIResponse, request: AIRequest, providerId: ProviderId): AIResponse {
  const sources = mergeAISources(attributeNativeSources(response.sources, providerId), collectRequestSources(request.messages));
  return sources.length ? { ...response, sources } : response;
}

function withSourceCollection(adapter: AIProviderAdapter): AIProviderAdapter {
  const wrapped: AIProviderAdapter = {
    id: adapter.id,
    displayName: adapter.displayName,
    requiresApiKey: adapter.requiresApiKey,
    fallbackCapabilities: adapter.fallbackCapabilities,
    listModels: (config) => adapter.listModels(config),
    send: async (config, request, signal) => withCollectedSources(await adapter.send(config, request, signal), request, adapter.id),
  };
  if (adapter.stream) {
    wrapped.stream = async function* (config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
      for await (const event of adapter.stream!(config, request, signal)) {
        if (event.type === 'complete' && event.response) {
          yield { ...event, response: withCollectedSources(event.response, request, adapter.id) };
          continue;
        }
        yield event;
      }
    };
  }
  return wrapped;
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, AIProviderAdapter>();

  constructor() {
    for (const adapter of createOpenAICompatibleProviderAdapters()) this.register(adapter);
    for (const adapter of createExpandedProviderAdapters()) this.register(adapter);
    this.register(new OllamaAdapter());
    this.register(new LMStudioProviderAdapter());
  }

  register(adapter: AIProviderAdapter): void {
    this.adapters.set(adapter.id, withSourceCollection(adapter));
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
