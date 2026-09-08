import type { AIMessage, AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, AIToolCall, IntelligenceLevel } from '../types';
import { createProviderRequestError } from '../provider-errors';
import { fetchWithTimeout } from '../sse';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const MODEL_LIST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const SHOW_CONCURRENCY = 4;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function errorMessage(value: unknown, fallback: string): string {
  const record = asRecord(value);
  const direct = typeof record?.error === 'string' ? record.error : undefined;
  const nested = asRecord(record?.error);
  const nestedMessage = typeof nested?.message === 'string' ? nested.message : undefined;
  return nestedMessage?.trim() || direct?.trim() || fallback;
}

function baseUrl(config: AIProviderConfig): string {
  return (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function usageFrom(value: unknown): AIResponse['usage'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const inputTokens = typeof record.prompt_eval_count === 'number' ? record.prompt_eval_count : undefined;
  const outputTokens = typeof record.eval_count === 'number' ? record.eval_count : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) };
}

function contextWindowFrom(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const values = Object.entries(record)
    .filter(([key]) => key.endsWith('.context_length'))
    .map(([, item]) => typeof item === 'number' && Number.isFinite(item) && item > 0 ? item : undefined)
    .filter((item): item is number => item !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

function mapMessages(messages: AIMessage[]): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      mapped.push({ role: 'tool', content: message.content, ...(message.toolName ? { tool_name: message.toolName } : {}) });
      continue;
    }
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls || []).map((call) => ({
        function: { name: call.name, arguments: call.input },
      }));
      mapped.push({ role: 'assistant', content: message.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    mapped.push({ role: message.role, content: message.content });
  }
  return mapped;
}

function mapTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== 'string') return undefined;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function reasoningValue(modelId: string, level: IntelligenceLevel): boolean | 'low' | 'medium' | 'high' {
  if (/gpt-oss/i.test(modelId)) {
    if (level === 'low') return 'low';
    if (level === 'normal') return 'medium';
    return 'high';
  }
  return level !== 'low';
}

async function* parseNdjson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('Ollama não retornou um stream legível.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseLine = (line: string): Record<string, unknown> => {
    try {
      const parsed = asRecord(JSON.parse(line) as unknown);
      if (!parsed) throw new Error('invalid chunk');
      return parsed;
    } catch {
      throw new Error('Ollama retornou um fragmento de streaming inválido.');
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield parseLine(line);
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) yield parseLine(tail);
}

export class OllamaAdapter implements AIProviderAdapter {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';
  readonly requiresApiKey = false;
  readonly fallbackCapabilities = ['text', 'streaming'] as const as AIModel['capabilities'];
  private readonly reasoningModels = new Set<string>();
  private toolCallSequence = 0;

  private nextToolCallId(): string {
    this.toolCallSequence += 1;
    return `ollama-tool-${this.toolCallSequence}`;
  }

  private parseToolCalls(value: unknown): AIToolCall[] {
    if (!Array.isArray(value)) return [];
    const calls: AIToolCall[] = [];
    for (const item of value) {
      const record = asRecord(item);
      const fn = asRecord(record?.function);
      if (typeof fn?.name !== 'string' || !fn.name.trim()) continue;
      const input = parseToolArguments(fn.arguments);
      if (!input) throw new Error('Ollama retornou argumentos inválidos para uma ferramenta.');
      calls.push({ id: this.nextToolCallId(), name: fn.name as AIToolCall['name'], input });
    }
    return calls;
  }

  private async showModel(config: AIProviderConfig, model: string): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await fetchWithTimeout(`${baseUrl(config)}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, verbose: false }),
      }, MODEL_LIST_TIMEOUT_MS);
      if (!response.ok) return undefined;
      return asRecord(await response.json().catch((): undefined => undefined));
    } catch {
      return undefined;
    }
  }

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(`${baseUrl(config)}/api/tags`, {}, MODEL_LIST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw createProviderRequestError(this.displayName, 'list-models', response.status, errorMessage(data, `Ollama models request failed: ${response.status}`));
    }
    if (!Array.isArray(data.models)) throw new Error('Ollama retornou uma lista de modelos inválida.');
    const ids = data.models.map((item) => {
      const record = asRecord(item);
      const id = typeof record?.model === 'string' ? record.model : typeof record?.name === 'string' ? record.name : '';
      return id.trim();
    }).filter(Boolean);

    this.reasoningModels.clear();
    const models: AIModel[] = [];
    for (let offset = 0; offset < ids.length; offset += SHOW_CONCURRENCY) {
      const batch = ids.slice(offset, offset + SHOW_CONCURRENCY);
      const details = await Promise.all(batch.map(async (id) => ({ id, details: await this.showModel(config, id) })));
      for (const { id, details: detail } of details) {
        if (!detail) continue;
        const capabilities = stringArray(detail.capabilities);
        if (capabilities.length && !capabilities.includes('completion')) continue;
        const normalized: AIModel['capabilities'] = ['text', 'streaming'];
        if (capabilities.includes('tools')) normalized.push('tools');
        if (capabilities.includes('thinking')) {
          normalized.push('reasoning');
          this.reasoningModels.add(id);
        }
        if (capabilities.includes('vision')) normalized.push('vision');
        const contextWindow = contextWindowFrom(detail.model_info);
        models.push({
          id,
          name: id,
          providerId: this.id,
          capabilities: normalized,
          ...(contextWindow ? { contextWindow } : {}),
          reasoningLevels: capabilities.includes('thinking') ? ['low', 'normal', 'high'] : ['normal'],
        });
      }
    }
    return models;
  }

  private requestBody(request: AIRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: mapMessages(request.messages),
      stream,
    };
    const tools = mapTools(request);
    if (tools) body.tools = tools;
    if (this.reasoningModels.has(request.model)) body.think = reasoningValue(request.model, request.intelligence);
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const response = await fetchWithTimeout(`${baseUrl(config)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.requestBody(request, false)),
      signal,
    }, REQUEST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw createProviderRequestError(this.displayName, 'send', response.status, errorMessage(data, `Ollama request failed: ${response.status}`));
    }
    const message = asRecord(data.message);
    return {
      content: typeof message?.content === 'string' ? message.content : '',
      model: request.model,
      providerId: this.id,
      usage: usageFrom(data),
      toolCalls: this.parseToolCalls(message?.tool_calls),
    };
  }

  async *stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<AIStreamEvent> {
    const response = await fetchWithTimeout(`${baseUrl(config)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.requestBody(request, true)),
      signal,
    }, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw createProviderRequestError(this.displayName, 'stream', response.status, errorMessage(data, `Ollama streaming request failed: ${response.status}`));
    }

    let content = '';
    let usage: AIResponse['usage'];
    let terminal = false;
    const rawToolCalls: unknown[] = [];
    yield { type: 'start' };

    for await (const chunk of parseNdjson(response)) {
      if (chunk.error) throw new Error(errorMessage(chunk, 'Ollama retornou um erro durante o streaming.'));
      const message = asRecord(chunk.message);
      const text = typeof message?.content === 'string' ? message.content : '';
      if (text) {
        content += text;
        yield { type: 'delta', text };
      }
      if (Array.isArray(message?.tool_calls)) rawToolCalls.push(...message.tool_calls);
      if (chunk.done === true) {
        terminal = true;
        usage = usageFrom(chunk);
      }
    }

    if (!terminal) throw new Error('Ollama encerrou o streaming sem um evento terminal.');
    const toolCalls = this.parseToolCalls(rawToolCalls);
    for (const toolCall of toolCalls) yield { type: 'tool_call', toolCall };
    const result: AIResponse = { content, model: request.model, providerId: this.id, usage, toolCalls };
    yield { type: 'complete', response: result, usage };
  }
}
