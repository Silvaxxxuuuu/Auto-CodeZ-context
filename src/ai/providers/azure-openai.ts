import type {
  AIMessage,
  AIModel,
  AIProviderAdapter,
  AIProviderConfig,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  AIToolCall,
} from '../types';
import { createProviderRequestError } from '../provider-errors';
import { fetchWithTimeout, parseSSE } from '../sse';

const MODEL_LIST_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;

function normalizeBaseUrl(value?: string): string {
  const raw = value?.trim().replace(/\/+$/, '');
  if (!raw) throw new Error('Azure OpenAI exige a URL base do recurso.');
  if (/\/openai\/v1$/i.test(raw)) return raw;
  if (/\/openai$/i.test(raw)) return `${raw}/v1`;
  return `${raw}/openai/v1`;
}

function reasoningLevels(model: string): AIRequest['intelligence'][] {
  const id = model.toLowerCase();
  if (/gpt-5\.6(?:-|$)/.test(id)) return ['low', 'normal', 'high', 'maximum'];
  if (/gpt-5-pro(?:-|$)/.test(id)) return ['high'];
  if (/gpt-5(?:\.\d+)?(?:-|$)/.test(id) || /gpt-5-(?:mini|nano|chat|codex)/.test(id)) return ['low', 'normal', 'high'];
  if (/^o[1-9](?:-|$)|deep-research|codex/i.test(id)) return ['low', 'normal', 'high'];
  return ['normal'];
}

function supportsReasoning(model: string): boolean {
  return reasoningLevels(model).some((level) => level !== 'normal');
}

function reasoningEffort(level: AIRequest['intelligence'], model: string): string | undefined {
  if (!supportsReasoning(model) || level === 'normal') return undefined;
  if (level === 'low') return 'low';
  if (level === 'high') return 'high';
  if (level === 'maximum') return reasoningLevels(model).includes('maximum') ? 'max' : 'high';
  return 'medium';
}

function buildInput(messages: AIMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
      continue;
    }
    input.push({ role: message.role, content: [{ type: 'input_text', text: message.content }] });
  }
  return input;
}

function buildTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  }));
}

function parseToolCalls(output: unknown): AIToolCall[] {
  if (!Array.isArray(output)) return [];
  const calls: AIToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { type?: string; call_id?: string; name?: string; arguments?: string };
    if (value.type !== 'function_call' || !value.call_id || !value.name) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(value.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    calls.push({ id: value.call_id, name: value.name as AIToolCall['name'], input });
  }
  return calls;
}

function providerErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  const responseError = (value as { response?: { error?: { message?: unknown } } }).response?.error?.message;
  return typeof responseError === 'string' && responseError.trim() ? responseError : fallback;
}

function headers(config: AIProviderConfig): Record<string, string> {
  return {
    'api-key': config.apiKey,
    'Content-Type': 'application/json',
  };
}

export class AzureOpenAIAdapter implements AIProviderAdapter {
  readonly id = 'azure-openai';
  readonly displayName = 'Azure OpenAI';

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(config.baseUrl)}/models`,
      { headers: { 'api-key': config.apiKey } },
      MODEL_LIST_TIMEOUT_MS,
    );
    const data = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) {
      throw createProviderRequestError(
        this.displayName,
        'list-models',
        response.status,
        data.error?.message || `Azure OpenAI models request failed: ${response.status}`,
      );
    }
    return (data.data || [])
      .map((model) => typeof model.id === 'string' ? model.id.trim() : '')
      .filter(Boolean)
      .map((id): AIModel => ({
        id,
        name: id,
        providerId: this.id,
        capabilities: ['text', 'streaming', 'tools', ...(supportsReasoning(id) ? ['reasoning'] : [])] as AIModel['capabilities'],
        reasoningLevels: reasoningLevels(id),
      }));
  }

  private buildBody(request: AIRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: buildInput(request.messages),
    };
    const effort = reasoningEffort(request.intelligence, request.model);
    if (effort) body.reasoning = { effort };
    const tools = buildTools(request);
    if (tools) body.tools = tools;
    if (stream) body.stream = true;
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(config.baseUrl)}/responses`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(this.buildBody(request)),
        signal,
      },
      REQUEST_TIMEOUT_MS,
    );
    const data = await response.json().catch(() => ({})) as {
      output_text?: string;
      output?: unknown;
      error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    if (!response.ok) {
      throw createProviderRequestError(
        this.displayName,
        'send',
        response.status,
        data.error?.message || `Azure OpenAI request failed: ${response.status}`,
      );
    }
    return {
      content: data.output_text || '',
      model: request.model,
      providerId: this.id,
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        totalTokens: data.usage?.total_tokens,
      },
      toolCalls: parseToolCalls(data.output),
    };
  }

  async *stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<AIStreamEvent> {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(config.baseUrl)}/responses`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(this.buildBody(request, true)),
        signal,
      },
      REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw createProviderRequestError(
        this.displayName,
        'stream',
        response.status,
        providerErrorMessage(data, `Azure OpenAI streaming request failed: ${response.status}`),
      );
    }

    let content = '';
    let usage: AIResponse['usage'];
    const toolCalls = new Map<string, AIToolCall>();
    const toolCallKeysByOutputIndex = new Map<number, string>();
    let terminal = false;
    yield { type: 'start' };

    for await (const raw of parseSSE(response, 30_000)) {
      const event = raw as {
        type?: string;
        delta?: string;
        item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string };
        item_id?: string;
        output_index?: number;
        arguments?: string;
        response?: {
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
          error?: { message?: string };
        };
        error?: { message?: string } | string;
      };

      if (event.type === 'response.output_text.delta' && event.delta) {
        content += event.delta;
        yield { type: 'delta', text: event.delta };
      }

      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item.call_id && event.item.name) {
        const key = event.item.id || event.item.call_id;
        toolCalls.set(key, { id: event.item.call_id, name: event.item.name as AIToolCall['name'], input: {} });
        if (typeof event.output_index === 'number') toolCallKeysByOutputIndex.set(event.output_index, key);
      }

      if (event.type === 'response.function_call_arguments.done') {
        const key = event.item_id
          || (typeof event.output_index === 'number' ? toolCallKeysByOutputIndex.get(event.output_index) : undefined)
          || event.item?.call_id;
        const existing = key ? toolCalls.get(key) : undefined;
        if (existing) {
          try {
            const parsed = JSON.parse(event.arguments ?? event.item?.arguments ?? '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing.input = parsed as Record<string, unknown>;
          } catch {
            throw new Error('Azure OpenAI retornou argumentos inválidos para uma ferramenta.');
          }
          yield { type: 'tool_call', toolCall: existing };
        }
      }

      if (event.type === 'response.completed') {
        terminal = true;
        if (event.response) {
          usage = {
            inputTokens: event.response.usage?.input_tokens,
            outputTokens: event.response.usage?.output_tokens,
            totalTokens: event.response.usage?.total_tokens,
          };
        }
      }

      if (event.type === 'response.failed') {
        terminal = true;
        throw new Error(providerErrorMessage(event, 'Azure OpenAI encerrou o streaming com falha.'));
      }
      if (event.type === 'error') {
        terminal = true;
        throw new Error(providerErrorMessage(event, 'Azure OpenAI retornou um erro durante o streaming.'));
      }
    }

    if (!terminal) throw new Error('Azure OpenAI encerrou o streaming sem um evento terminal.');
    const result: AIResponse = {
      content,
      model: request.model,
      providerId: this.id,
      usage,
      toolCalls: [...toolCalls.values()],
    };
    yield { type: 'complete', response: result, usage };
  }
}
