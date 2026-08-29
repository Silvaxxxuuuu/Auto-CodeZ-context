import type { AIMessage, AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, AIToolCall } from '../types';
import { parseSSE } from '../sse';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name?: string; response?: unknown; id?: string };
};

type GoogleChunk = {
  candidates?: Array<{ content?: { parts?: GooglePart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string };
};

function buildTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return [{
    functionDeclarations: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }];
}

function buildContents(messages: AIMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!message.toolName) continue;
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: message.toolName, response: { result: message.content }, ...(message.toolCallId ? { id: message.toolCallId } : {}) } }],
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: GooglePart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({
          functionCall: { name: call.name, args: call.input, id: call.id },
          ...(call.providerData?.thoughtSignature ? { thoughtSignature: String(call.providerData.thoughtSignature) } : {}),
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }
  return contents;
}

function parseToolCalls(parts: GooglePart[]): AIToolCall[] {
  return parts.flatMap((part) => {
    if (!part.functionCall?.name) return [];
    return [{
      id: part.functionCall.id || `google_${part.functionCall.name}_${Math.random().toString(36).slice(2)}`,
      name: part.functionCall.name as AIToolCall['name'],
      input: part.functionCall.args || {},
      providerData: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined,
    }];
  });
}

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
    const body: Record<string, unknown> = {
      systemInstruction: systemMessages.length ? { parts: systemMessages.map((message) => ({ text: message.content })) } : undefined,
      contents: buildContents(request.messages),
    };
    const tools = buildTools(request);
    if (tools) body.tools = tools;
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildBody(request)),
    });

    const data = (await response.json()) as GoogleChunk;
    if (!response.ok) throw new Error(data.error?.message || `Google AI request failed: ${response.status}`);

    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((part) => !part.thought && part.text).map((part) => part.text || '').join('');
    return {
      content,
      model: request.model,
      providerId: this.id,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
        totalTokens: data.usageMetadata?.totalTokenCount,
      },
      toolCalls: parseToolCalls(parts),
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
    const toolCalls: AIToolCall[] = [];
    yield { type: 'start' };

    for await (const raw of parseSSE(response)) {
      const chunk = raw as GoogleChunk;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.thought) continue;
        if (part.text) {
          content += part.text;
          yield { type: 'delta', text: part.text };
        }
        if (part.functionCall) {
          const parsed = parseToolCalls([part]);
          for (const call of parsed) {
            toolCalls.push(call);
            yield { type: 'tool_call', toolCall: call };
          }
        }
      }
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount,
          outputTokens: chunk.usageMetadata.candidatesTokenCount,
          totalTokens: chunk.usageMetadata.totalTokenCount,
        };
      }
    }

    const result: AIResponse = { content, model: request.model, providerId: this.id, usage, toolCalls };
    yield { type: 'complete', response: result, usage };
  }
}
