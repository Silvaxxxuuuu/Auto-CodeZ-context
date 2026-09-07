import type { AIMessage, AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, AIToolCall, Capability, IntelligenceLevel, ProviderId } from '../types';
import { createProviderRequestError } from '../provider-errors';
import { fetchWithTimeout, parseSSE } from '../sse';

const MODEL_LIST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

type ReasoningStyle = 'none' | 'effort' | 'object';

export interface OpenAICompatibleProviderDescriptor {
  id: ProviderId;
  displayName: string;
  baseUrl: string;
  toolsByDefault: boolean;
  reasoningStyle?: ReasoningStyle;
  reasoningModelPattern?: RegExp;
}

export const OPENAI_COMPATIBLE_PROVIDERS: readonly OpenAICompatibleProviderDescriptor[] = [
  { id: 'groq', displayName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', toolsByDefault: true },
  { id: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', toolsByDefault: true },
  { id: 'xai', displayName: 'xAI', baseUrl: 'https://api.x.ai/v1', toolsByDefault: true },
  { id: 'mistral', displayName: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', toolsByDefault: true },
  { id: 'openrouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', toolsByDefault: true, reasoningStyle: 'object' },
  { id: 'together', displayName: 'Together AI', baseUrl: 'https://api.together.ai/v1', toolsByDefault: true, reasoningStyle: 'effort', reasoningModelPattern: /gpt-oss/i },
  { id: 'fireworks', displayName: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', toolsByDefault: true },
  { id: 'cerebras', displayName: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', toolsByDefault: true, reasoningStyle: 'effort', reasoningModelPattern: /(gpt-oss|zai-glm)/i },
  { id: 'huggingface', displayName: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', toolsByDefault: false },
] as const;

interface CompatibleModelRecord {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  supported_parameters?: unknown;
  architecture?: unknown;
  providers?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function errorMessage(value: unknown, fallback: string): string {
  const record = asRecord(value);
  const error = asRecord(record?.error);
  const direct = typeof record?.error === 'string' ? record.error : undefined;
  const message = typeof error?.message === 'string' ? error.message : direct;
  return message?.trim() || fallback;
}

function baseUrl(config: AIProviderConfig, descriptor: OpenAICompatibleProviderDescriptor): string {
  return (config.baseUrl?.trim() || descriptor.baseUrl).replace(/\/+$/, '');
}

function authorizationHeaders(config: AIProviderConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    const record = asRecord(part);
    return typeof record?.text === 'string' ? record.text : '';
  }).join('');
}

function parseToolCall(value: unknown): AIToolCall | undefined {
  const record = asRecord(value);
  const fn = asRecord(record?.function);
  if (typeof record?.id !== 'string' || typeof fn?.name !== 'string') return undefined;
  let input: Record<string, unknown> = {};
  const rawArguments = typeof fn.arguments === 'string' ? fn.arguments : '{}';
  try {
    const parsed = asRecord(JSON.parse(rawArguments) as unknown);
    if (parsed) input = parsed;
  } catch {
    return undefined;
  }
  return { id: record.id, name: fn.name as AIToolCall['name'], input };
}

function parseToolCalls(value: unknown): AIToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseToolCall).filter((item): item is AIToolCall => Boolean(item));
}

function usageFrom(value: unknown): AIResponse['usage'] | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function providerContexts(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function modelContextWindow(record: CompatibleModelRecord): number | undefined {
  const direct = finitePositiveNumber(record.context_length) ?? finitePositiveNumber(record.context_window);
  if (direct) return direct;
  const providerValues = providerContexts(record.providers)
    .map((item) => finitePositiveNumber(item.context_length))
    .filter((item): item is number => item !== undefined);
  return providerValues.length ? Math.max(...providerValues) : undefined;
}

function hasProviderToolSupport(record: CompatibleModelRecord): boolean {
  return providerContexts(record.providers).some((item) => item.supports_tools === true);
}

function outputSupportsText(record: CompatibleModelRecord): boolean {
  const architecture = asRecord(record.architecture);
  const outputModalities = stringArray(architecture?.output_modalities);
  return outputModalities.length === 0 || outputModalities.includes('text');
}

function inputSupportsVision(record: CompatibleModelRecord): boolean {
  const architecture = asRecord(record.architecture);
  return stringArray(architecture?.input_modalities).includes('image');
}

function reasoningEffort(level: IntelligenceLevel): 'low' | 'medium' | 'high' {
  if (level === 'low') return 'low';
  if (level === 'normal') return 'medium';
  return 'high';
}

function mapMessages(messages: AIMessage[]): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) mapped.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls || []).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      }));
      mapped.push({ role: 'assistant', content: message.content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
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

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  private readonly reasoningModels = new Set<string>();

  constructor(readonly descriptor: OpenAICompatibleProviderDescriptor) {
    this.id = descriptor.id;
    this.displayName = descriptor.displayName;
  }

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(`${baseUrl(config, this.descriptor)}/models`, {
      headers: authorizationHeaders(config),
    }, MODEL_LIST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw createProviderRequestError(this.displayName, 'list-models', response.status, errorMessage(data, `${this.displayName} models request failed: ${response.status}`));
    }
    if (!Array.isArray(data.data)) throw new Error(`${this.displayName} retornou uma lista de modelos inválida.`);
    this.reasoningModels.clear();
    const models: AIModel[] = [];
    for (const raw of data.data) {
      const record = asRecord(raw) as CompatibleModelRecord | undefined;
      const id = typeof record?.id === 'string' ? record.id.trim() : '';
      if (!record || !id || !outputSupportsText(record)) continue;
      const supportedParameters = stringArray(record.supported_parameters);
      const explicitTools = supportedParameters.length > 0 ? supportedParameters.includes('tools') : undefined;
      const tools = explicitTools ?? (hasProviderToolSupport(record) || this.descriptor.toolsByDefault);
      const reasoningStyle = this.descriptor.reasoningStyle ?? 'none';
      const metadataReasoning = supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort');
      const patternReasoning = Boolean(this.descriptor.reasoningModelPattern?.test(id));
      const reasoning = reasoningStyle !== 'none' && (metadataReasoning || patternReasoning);
      if (reasoning) this.reasoningModels.add(id);
      const capabilities: Capability[] = ['text', 'streaming'];
      if (tools) capabilities.push('tools');
      if (reasoning) capabilities.push('reasoning');
      if (inputSupportsVision(record)) capabilities.push('vision');
      const contextWindow = modelContextWindow(record);
      models.push({
        id,
        name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
        providerId: this.id,
        capabilities,
        ...(contextWindow ? { contextWindow } : {}),
        reasoningLevels: reasoning ? ['low', 'normal', 'high'] : ['normal'],
      });
    }
    return models;
  }

  private requestBody(request: AIRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { model: request.model, messages: mapMessages(request.messages) };
    const tools = mapTools(request);
    if (tools) body.tools = tools;
    if (stream) body.stream = true;
    if (this.reasoningModels.has(request.model)) {
      const effort = reasoningEffort(request.intelligence);
      if (this.descriptor.reasoningStyle === 'effort') body.reasoning_effort = effort;
      if (this.descriptor.reasoningStyle === 'object') body.reasoning = { effort };
    }
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const response = await fetchWithTimeout(`${baseUrl(config, this.descriptor)}/chat/completions`, {
      method: 'POST',
      headers: { ...authorizationHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(this.requestBody(request, false)),
      signal,
    }, REQUEST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw createProviderRequestError(this.displayName, 'send', response.status, errorMessage(data, `${this.displayName} request failed: ${response.status}`));
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    return {
      content: contentText(message?.content),
      model: request.model,
      providerId: this.id,
      usage: usageFrom(data.usage),
      toolCalls: parseToolCalls(message?.tool_calls),
    };
  }

  async *stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<AIStreamEvent> {
    const response = await fetchWithTimeout(`${baseUrl(config, this.descriptor)}/chat/completions`, {
      method: 'POST',
      headers: { ...authorizationHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(this.requestBody(request, true)),
      signal,
    }, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw createProviderRequestError(this.displayName, 'stream', response.status, errorMessage(data, `${this.displayName} streaming request failed: ${response.status}`));
    }

    let content = '';
    let usage: AIResponse['usage'];
    let terminal = false;
    const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
    yield { type: 'start' };

    for await (const raw of parseSSE(response)) {
      const chunk = asRecord(raw) ?? {};
      if (chunk.error) throw new Error(errorMessage(chunk, `${this.displayName} retornou um erro durante o streaming.`));
      const nextUsage = usageFrom(chunk.usage);
      if (nextUsage) usage = nextUsage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choiceValue of choices) {
        const choice = asRecord(choiceValue);
        const delta = asRecord(choice?.delta);
        const text = contentText(delta?.content);
        if (text) {
          content += text;
          yield { type: 'delta', text };
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const callValue of delta.tool_calls) {
            const call = asRecord(callValue);
            const index = typeof call?.index === 'number' ? call.index : 0;
            const fn = asRecord(call?.function);
            const current = pendingCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (typeof call?.id === 'string') current.id = call.id;
            if (typeof fn?.name === 'string') current.name += fn.name;
            if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
            pendingCalls.set(index, current);
          }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) terminal = true;
      }
    }

    if (!terminal) throw new Error(`${this.displayName} encerrou o streaming sem um evento terminal.`);
    const toolCalls: AIToolCall[] = [];
    for (const [, call] of [...pendingCalls.entries()].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) continue;
      let input: Record<string, unknown>;
      try {
        const parsed = asRecord(JSON.parse(call.arguments || '{}') as unknown);
        if (!parsed) throw new Error('invalid tool input');
        input = parsed;
      } catch {
        throw new Error(`${this.displayName} retornou argumentos inválidos para uma ferramenta.`);
      }
      const toolCall: AIToolCall = { id: call.id, name: call.name as AIToolCall['name'], input };
      toolCalls.push(toolCall);
      yield { type: 'tool_call', toolCall };
    }
    const result: AIResponse = { content, model: request.model, providerId: this.id, usage, toolCalls };
    yield { type: 'complete', response: result, usage };
  }
}

export function createOpenAICompatibleProviderAdapters(): AIProviderAdapter[] {
  return OPENAI_COMPATIBLE_PROVIDERS.map((descriptor) => new OpenAICompatibleAdapter(descriptor));
}
