import type { AIMessage, AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, AIToolCall } from '../types';
import { parseSSE } from '../sse';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function reasoningEffort(level: AIRequest['intelligence']): string | undefined {
  if (level === 'normal') return undefined;
  if (level === 'low') return 'low';
  if (level === 'maximum') return 'high';
  return level;
}

function buildInput(messages: AIMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
      continue;
    }
    input.push({
      role: message.role,
      content: [{ type: 'input_text', text: message.content }],
    });
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

export class OpenAIAdapter implements AIProviderAdapter {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`OpenAI models request failed: ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data || [])
      .filter((model) => /^(gpt|o[1-9]|chatgpt)/i.test(model.id))
      .map((model) => ({
        id: model.id,
        name: model.id,
        providerId: this.id,
        capabilities: ['text', 'streaming', 'tools', 'reasoning'],
        reasoningLevels: ['low', 'normal', 'high', 'maximum'],
      }));
  }

  private buildBody(request: AIRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: buildInput(request.messages),
    };
    const effort = reasoningEffort(request.intelligence);
    if (effort) body.reasoning = { effort };
    const tools = buildTools(request);
    if (tools) body.tools = tools;
    if (stream) body.stream = true;
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(request)),
    });

    const data = (await response.json()) as {
      output_text?: string;
      output?: unknown;
      error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };

    if (!response.ok) throw new Error(data.error?.message || `OpenAI request failed: ${response.status}`);

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

  async *stream(config: AIProviderConfig, request: AIRequest): AsyncGenerator<AIStreamEvent> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(request, true)),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(data.error?.message || `OpenAI streaming request failed: ${response.status}`);
    }

    let content = '';
    let usage: AIResponse['usage'];
    const toolCalls = new Map<string, AIToolCall>();
    yield { type: 'start' };

    for await (const raw of parseSSE(response)) {
      const event = raw as {
        type?: string;
        delta?: string;
        item?: { type?: string; call_id?: string; name?: string; arguments?: string };
        response?: { output_text?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
      };
      if (event.type === 'response.output_text.delta' && event.delta) {
        content += event.delta;
        yield { type: 'delta', text: event.delta };
      }
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item.call_id && event.item.name) {
        toolCalls.set(event.item.call_id, { id: event.item.call_id, name: event.item.name as AIToolCall['name'], input: {} });
      }
      if (event.type === 'response.function_call_arguments.done' && event.item?.call_id) {
        const existing = toolCalls.get(event.item.call_id);
        if (existing) {
          try {
            const parsed = JSON.parse(event.item.arguments || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing.input = parsed as Record<string, unknown>;
          } catch {
            throw new Error('OpenAI retornou argumentos inválidos para uma ferramenta.');
          }
          yield { type: 'tool_call', toolCall: existing };
        }
      }
      if (event.type === 'response.completed' && event.response) {
        usage = {
          inputTokens: event.response.usage?.input_tokens,
          outputTokens: event.response.usage?.output_tokens,
          totalTokens: event.response.usage?.total_tokens,
        };
      }
      if (event.type === 'error') throw new Error('OpenAI retornou um erro durante o streaming.');
    }

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
