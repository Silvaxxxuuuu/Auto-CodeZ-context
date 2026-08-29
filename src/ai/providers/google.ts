import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse } from '../types';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GoogleAdapter implements AIProviderAdapter {
  readonly id = 'google';
  readonly displayName = 'Google AI';

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models?key=${encodeURIComponent(config.apiKey)}`);
    if (!response.ok) throw new Error(`Google models request failed: ${response.status}`);
    const data = (await response.json()) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models || [])
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
      .map((model) => ({
        id: model.name.replace(/^models\//, ''),
        name: model.displayName || model.name.replace(/^models\//, ''),
        providerId: this.id,
        capabilities: ['text', 'vision', 'streaming', 'tools', 'reasoning'],
        reasoningLevels: ['low', 'normal', 'high', 'maximum'],
      }));
  }

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents }),
    });

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };

    if (!response.ok) throw new Error(data.error?.message || `Google AI request failed: ${response.status}`);

    const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    return {
      content,
      model: request.model,
      providerId: this.id,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
        totalTokens: data.usageMetadata?.totalTokenCount,
      },
    };
  }
}
