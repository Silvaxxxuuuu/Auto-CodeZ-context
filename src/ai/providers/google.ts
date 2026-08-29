import type { AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent } from '../types';
import { parseSSE } from '../sse';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type GoogleChunk = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string };
};

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

  private buildBody(request: AIRequest): Record<string, unknown> {
    const systemMessages = request.messages.filter((message) => message.role === 'system');
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
    return {
      systemInstruction: systemMessages.length ? { parts: systemMessages.map((message) => ({ text: message.content })) } : undefined,
      contents,
    };
  }

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildBody(request)),
    });

    const data = (await response.json()) as GoogleChunk;
    if (!response.ok) throw new Error(data.error?.message || `Google AI request failed: ${response.status}`);

    const content = data.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('') || '';
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

  async *stream(config: AIProviderConfig, request: AIRequest): AsyncGenerator<AIStreamEvent> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildBody(request)),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as GoogleChunk;
      throw new Error(data.error?.message || `Google AI streaming request failed: ${response.status}`);
    }

    let content = '';
    let usage: AIResponse['usage'];
    yield { type: 'start' };

    for await (const raw of parseSSE(response)) {
      const chunk = raw as GoogleChunk;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.thought || !part.text) continue;
        content += part.text;
        yield { type: 'delta', text: part.text };
      }
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount,
          outputTokens: chunk.usageMetadata.candidatesTokenCount,
          totalTokens: chunk.usageMetadata.totalTokenCount,
        };
      }
    }

    const result: AIResponse = { content, model: request.model, providerId: this.id, usage };
    yield { type: 'complete', response: result, usage };
  }
}
