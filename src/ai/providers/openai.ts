import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent } from '../types';
import { parseSSE } from '../sse';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function reasoningEffort(level: AIRequest['intelligence']): string | undefined {
  if (level === 'normal') return undefined;
  if (level === 'low') return 'low';
  if (level === 'maximum') return 'high';
  return level;
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
      input: request.messages.map((message) => ({
        role: message.role,
        content: [{ type: 'input_text', text: message.content }],
      })),
    };
    const effort = reasoningEffort(request.intelligence);
    if (effort) body.reasoning = { effort };
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
    yield { type: 'start' };

    for await (const raw of parseSSE(response)) {
      const event = raw as { type?: string; delta?: string; response?: { output_text?: string; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } };
      if (event.type === 'response.output_text.delta' && event.delta) {
        content += event.delta;
        yield { type: 'delta', text: event.delta };
      }
      if (event.type === 'response.completed' && event.response) {
        usage = {
          inputTokens: event.response.usage?.input_tokens,
          outputTokens: event.response.usage?.output_tokens,
          totalTokens: event.response.usage?.total_tokens,
        };
      }
      if (event.type === 'error') {
        throw new Error('OpenAI retornou um erro durante o streaming.');
      }
    }

    const result: AIResponse = { content, model: request.model, providerId: this.id, usage };
    yield { type: 'complete', response: result, usage };
  }
}
