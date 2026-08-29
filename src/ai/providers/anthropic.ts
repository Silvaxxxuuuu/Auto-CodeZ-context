import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent } from '../types';
import { parseSSE } from '../sse';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

function supportsEffort(model: string): boolean {
  return /claude-(opus|sonnet|fable|mythos)-5|claude-(opus|sonnet)-4-7|claude-opus-4-8/i.test(model);
}

function effort(level: AIRequest['intelligence']): string {
  if (level === 'low') return 'low';
  if (level === 'normal') return 'medium';
  if (level === 'high') return 'high';
  return 'max';
}

type AnthropicEvent = {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

export class AnthropicAdapter implements AIProviderAdapter {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models`, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) throw new Error(`Anthropic models request failed: ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (data.data || []).map((model) => ({
      id: model.id,
      name: model.display_name || model.id,
      providerId: this.id,
      capabilities: ['text', 'vision', 'streaming', 'tools', 'reasoning'],
      reasoningLevels: ['low', 'normal', 'high', 'maximum'],
    }));
  }

  private buildBody(request: AIRequest, stream = false): Record<string, unknown> {
    const systemMessages = request.messages.filter((message) => message.role === 'system');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: 8192,
      system: systemMessages.map((message) => message.content).join('\n\n') || undefined,
      messages,
      stream,
    };
    if (supportsEffort(request.model)) body.output_config = { effort: effort(request.intelligence) };
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(request)),
    });

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    if (!response.ok) throw new Error(data.error?.message || `Anthropic request failed: ${response.status}`);

    return {
      content: data.content?.filter((item) => item.type === 'text').map((item) => item.text || '').join('') || '',
      model: request.model,
      providerId: this.id,
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  async *stream(config: AIProviderConfig, request: AIRequest): AsyncGenerator<AIStreamEvent> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(request, true)),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(data.error?.message || `Anthropic streaming request failed: ${response.status}`);
    }

    let content = '';
    let usage: AIResponse['usage'];
    yield { type: 'start' };

    for await (const raw of parseSSE(response)) {
      const event = raw as AnthropicEvent;
      if (event.type === 'error' && event.error?.message) throw new Error(event.error.message);
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        content += event.delta.text;
        yield { type: 'delta', text: event.delta.text };
      }
      if (event.type === 'message_start' && event.message?.usage) {
        usage = { inputTokens: event.message.usage.input_tokens, outputTokens: event.message.usage.output_tokens };
      }
      if (event.type === 'message_delta' && event.usage) {
        usage = {
          inputTokens: usage?.inputTokens,
          outputTokens: event.usage.output_tokens,
          totalTokens: (usage?.inputTokens || 0) + (event.usage.output_tokens || 0),
        };
      }
    }

    const result: AIResponse = { content, model: request.model, providerId: this.id, usage };
    yield { type: 'complete', response: result, usage };
  }
}
