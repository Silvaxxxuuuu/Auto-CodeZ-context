import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse } from '../types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

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

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const systemMessages = request.messages.filter((message) => message.role === 'system');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 8192,
        system: systemMessages.map((message) => message.content).join('\n\n') || undefined,
        messages,
      }),
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
}
