import type {
  AIModel,
  AIProviderAdapter,
  AIProviderConfig,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  Capability,
} from '../types';
import { getLocalRuntimeConnection } from '../local-runtime-settings';
import { LMStudioLocalRuntimeAdapter } from '../local-runtimes/lm-studio';
import { OpenAICompatibleAdapter } from './openai-compatible';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234';

export type LMStudioProviderOptions = {
  endpoint?: string;
  apiToken?: string;
};

function normalizeServerRoot(value?: string): string {
  const normalized = (value?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  return normalized.toLowerCase().endsWith('/v1') ? normalized.slice(0, -3).replace(/\/+$/, '') : normalized;
}

function capabilities(values: string[] | undefined): Capability[] {
  const mapped: Capability[] = ['text', 'streaming'];
  if (values?.includes('tools')) mapped.push('tools');
  if (values?.includes('vision')) mapped.push('vision');
  return mapped;
}

export class LMStudioProviderAdapter implements AIProviderAdapter {
  readonly id = 'lm-studio';
  readonly displayName = 'LM Studio';
  readonly requiresApiKey = false;
  readonly fallbackCapabilities: Capability[] = ['text', 'streaming'];
  private readonly endpointOverride?: string;
  private readonly apiTokenOverride?: string;
  private readonly transport: OpenAICompatibleAdapter;

  constructor(options: LMStudioProviderOptions = {}) {
    this.endpointOverride = options.endpoint?.trim() ? normalizeServerRoot(options.endpoint) : undefined;
    this.apiTokenOverride = options.apiToken?.trim() || undefined;
    this.transport = new OpenAICompatibleAdapter({
      id: this.id,
      displayName: this.displayName,
      baseUrl: `${this.endpointOverride || DEFAULT_ENDPOINT}/v1`,
      toolsByDefault: false,
    });
  }

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const runtime = new LMStudioLocalRuntimeAdapter({
      endpoint: this.serverRoot(config),
      apiToken: this.apiToken(),
    });
    const models = await runtime.listInstalled();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      providerId: this.id,
      capabilities: capabilities(model.capabilities),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      reasoningLevels: ['normal'],
    }));
  }

  async send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    return this.transport.send(this.transportConfig(config), { ...request, providerId: this.id }, signal);
  }

  async *stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<AIStreamEvent> {
    yield* this.transport.stream(this.transportConfig(config), { ...request, providerId: this.id }, signal);
  }

  private serverRoot(config: AIProviderConfig): string {
    const connection = getLocalRuntimeConnection('lm-studio');
    return normalizeServerRoot(this.endpointOverride || config.baseUrl || connection.endpoint);
  }

  private apiToken(): string | undefined {
    return this.apiTokenOverride || getLocalRuntimeConnection('lm-studio').apiToken;
  }

  private transportConfig(config: AIProviderConfig): AIProviderConfig {
    return {
      id: this.id,
      displayName: this.displayName,
      apiKey: this.apiToken() || '',
      baseUrl: `${this.serverRoot(config)}/v1`,
      ...(config.selectedModel ? { selectedModel: config.selectedModel } : {}),
      enabled: true,
    };
  }
}
