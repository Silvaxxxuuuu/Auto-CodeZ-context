import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse } from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

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

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: request.messages.map((message) => ({
        role: message.role,
        content: [{ type: 'input_text', text: message.content }],
      })),
    };

    if (request.intelligence !== 'normal') {
      body.reasoning = { effort: request.intelligence === 'low' ? 'low' : request.intelligence === 'maximum' ? 'high' : request.intelligence };
    }

    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
}
