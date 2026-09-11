import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, Capability } from '../types';
import { getAutoCodezLocalService } from '../auto-codez-local-service';
import { OpenAICompatibleAdapter } from './openai-compatible';

const LOCAL_REQUEST_TIMEOUT_MS = 45_000;
const LOCAL_STREAM_IDLE_TIMEOUT_MS = 30_000;

function capabilities(values: string[] | undefined): Capability[] {
  const allowed = new Set<Capability>(['text', 'vision', 'reasoning', 'tools', 'streaming']);
  const result: Capability[] = ['text', 'streaming'];
  for (const value of values ?? []) {
    if (allowed.has(value as Capability) && !result.includes(value as Capability)) result.push(value as Capability);
  }
  return result;
}

function localRequestExtras(request: AIRequest): Record<string, unknown> {
  const deeperReasoning = request.intelligence === 'high' || request.intelligence === 'maximum';
  return {
    chat_template_kwargs: { enable_thinking: deeperReasoning },
    max_tokens: deeperReasoning ? 4096 : 2048,
    temperature: deeperReasoning ? 0.6 : 0.7,
    top_p: deeperReasoning ? 0.95 : 0.8,
  };
}

export class AutoCodezLocalProviderAdapter implements AIProviderAdapter {
  readonly id = 'auto-codez-local';
  readonly displayName = 'Auto CodeZ Local';
  readonly requiresApiKey = false;
  readonly fallbackCapabilities: Capability[] = ['text', 'streaming', 'tools'];

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    void config;
    const service = getAutoCodezLocalService();
    if (!service) return [];
    const models = await service.listInstalled();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      providerId: this.id,
      capabilities: capabilities(model.capabilities),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      reasoningLevels: model.capabilities?.includes('reasoning') ? ['low', 'normal', 'high'] : ['normal'],
    }));
  }

  private async transport(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal) {
    const service = getAutoCodezLocalService();
    if (!service) throw new Error('Auto CodeZ Local ainda não foi inicializado.');
    const endpoint = await service.ensureServer(request.model, signal);
    const adapter = new OpenAICompatibleAdapter({
      id: this.id,
      displayName: this.displayName,
      baseUrl: `${endpoint}/v1`,
      toolsByDefault: true,
      requestTimeoutMs: LOCAL_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: LOCAL_STREAM_IDLE_TIMEOUT_MS,
      requestBodyExtras: localRequestExtras,
    });
    const localConfig: AIProviderConfig = {
      ...config,
      id: this.id,
      displayName: this.displayName,
      apiKey: '',
      baseUrl: `${endpoint}/v1`,
      selectedModel: request.model,
      enabled: true,
    };
    return { adapter, localConfig };
  }

  async send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const { adapter, localConfig } = await this.transport(config, request, signal);
    return adapter.send(localConfig, { ...request, providerId: this.id }, signal);
  }

  async *stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
    yield {
      type: 'activity',
      activity: { type: 'action', message: `Carregando ${request.model} no Auto CodeZ Local.`, status: 'running' },
    };
    const { adapter, localConfig } = await this.transport(config, request, signal);
    yield {
      type: 'activity',
      activity: { type: 'action', message: 'Modelo local pronto. Gerando resposta.', status: 'success' },
    };
    if (!adapter.stream) {
      const response = await adapter.send(localConfig, { ...request, providerId: this.id }, signal);
      yield { type: 'complete', response };
      return;
    }
    yield* adapter.stream(localConfig, { ...request, providerId: this.id }, signal);
  }
}
