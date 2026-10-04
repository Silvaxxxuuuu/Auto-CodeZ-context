import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent } from '../types';
import { createProviderRequestError } from '../provider-errors';
import { fetchWithTimeout } from '../sse';
import { OpenAICompatibleAdapter } from './openai-compatible';

const MODEL_LIST_TIMEOUT_MS = 30_000;

const SAMBANOVA_DESCRIPTOR = {
  id: 'sambanova',
  displayName: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
  toolsByDefault: true,
  reasoningStyle: 'effort' as const,
  reasoningModelPattern: /gpt-oss/i,
};

const SILICONFLOW_DESCRIPTOR = {
  id: 'siliconflow',
  displayName: 'SiliconFlow',
  baseUrl: 'https://api.siliconflow.cn/v1',
  toolsByDefault: true,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorMessage(value: unknown, fallback: string): string {
  const record = asRecord(value);
  const error = asRecord(record?.error);
  const direct = typeof record?.error === 'string' ? record.error : undefined;
  const message = typeof error?.message === 'string' ? error.message : direct;
  return message?.trim() || fallback;
}

function normalizedBaseUrl(config: AIProviderConfig): string {
  return (config.baseUrl?.trim() || SILICONFLOW_DESCRIPTOR.baseUrl).replace(/\/+$/, '');
}

export class SiliconFlowAdapter implements AIProviderAdapter {
  readonly id = SILICONFLOW_DESCRIPTOR.id;
  readonly displayName = SILICONFLOW_DESCRIPTOR.displayName;
  private readonly delegate = new OpenAICompatibleAdapter(SILICONFLOW_DESCRIPTOR);

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(`${normalizedBaseUrl(config)}/models?sub_type=chat`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    }, MODEL_LIST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw createProviderRequestError(
        this.displayName,
        'list-models',
        response.status,
        errorMessage(data, `${this.displayName} models request failed: ${response.status}`),
      );
    }
    if (!Array.isArray(data.data)) throw new Error(`${this.displayName} retornou uma lista de modelos inválida.`);

    const seen = new Set<string>();
    const models: AIModel[] = [];
    for (const raw of data.data) {
      const record = asRecord(raw);
      const id = typeof record?.id === 'string' ? record.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        name: typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : id,
        providerId: this.id,
        capabilities: ['text', 'streaming', 'tools'],
        reasoningLevels: ['normal'],
      });
    }
    return models;
  }

  send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    return this.delegate.send(config, request, signal);
  }

  stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
    return this.delegate.stream(config, request, signal);
  }
}

export function createExpandedProviderAdapters(): AIProviderAdapter[] {
  return [
    new OpenAICompatibleAdapter(SAMBANOVA_DESCRIPTOR),
    new SiliconFlowAdapter(),
  ];
}
