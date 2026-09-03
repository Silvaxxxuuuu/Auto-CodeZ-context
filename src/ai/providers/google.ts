import type { AIMessage, AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, AIToolCall } from '../types';
import { fetchWithTimeout, parseSSE } from '../sse';
import { createProviderRequestError } from '../provider-errors';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_LIST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

type GooglePart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown>; id?: string }; functionResponse?: { name?: string; response?: unknown; id?: string } };
type GoogleChunk = { candidates?: Array<{ content?: { parts?: GooglePart[] } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }; error?: { message?: string } };
type GoogleSchema = Record<string, unknown>;

function isGemini3Model(model: string): boolean { return /(?:^|[-_])gemini-3(?:\.|-|$)/i.test(model); }
function isGemini25Model(model: string): boolean { return /(?:^|[-_])gemini-2\.5(?:\.|-|$)/i.test(model); }
function isThinkingModel(model: string): boolean { return isGemini3Model(model) || isGemini25Model(model); }
function thinkingLevel(level: AIRequest['intelligence']): 'low' | 'medium' | 'high' { if (level === 'low') return 'low'; if (level === 'high' || level === 'maximum') return 'high'; return 'medium'; }
function thinkingBudget(level: AIRequest['intelligence']): number { if (level === 'low') return 1024; if (level === 'high' || level === 'maximum') return 24576; return 8192; }

function toGoogleSchema(value: unknown): GoogleSchema | unknown {
  if (Array.isArray(value)) return value.map(toGoogleSchema);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const schema: GoogleSchema = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === 'additionalProperties') continue;
    if (key === 'properties' && item && typeof item === 'object' && !Array.isArray(item)) {
      schema.properties = Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([name, property]) => [name, toGoogleSchema(property)]));
      continue;
    }
    schema[key] = toGoogleSchema(item);
  }
  return schema;
}

function buildTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toGoogleSchema(tool.parameters) })) }];
}

function buildContents(messages: AIMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const parts: Array<Record<string, unknown>> = [];
      while (index < messages.length && messages[index].role === 'tool') {
        const toolMessage = messages[index];
        if (toolMessage.toolName) parts.push({ functionResponse: { name: toolMessage.toolName, response: { result: toolMessage.content }, ...(toolMessage.toolCallId ? { id: toolMessage.toolCallId } : {}) } });
        index += 1;
      }
      index -= 1;
      if (parts.length) contents.push({ role: 'user', parts });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: GooglePart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) parts.push({ functionCall: { name: call.name, args: call.input, id: call.id }, ...(call.providerData?.thoughtSignature ? { thoughtSignature: String(call.providerData.thoughtSignature) } : {}) });
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
  }
  return contents;
}

function parseToolCalls(parts: GooglePart[]): AIToolCall[] {
  return parts.flatMap((part) => {
    if (!part.functionCall?.name) return [];
    return [{ id: part.functionCall.id || `google_${part.functionCall.name}_${Math.random().toString(36).slice(2)}`, name: part.functionCall.name as AIToolCall['name'], input: part.functionCall.args || {}, providerData: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined }];
  });
}

function providerErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const error = (value as { error?: unknown }).error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export class GoogleAdapter implements AIProviderAdapter {
  readonly id = 'google';
  readonly displayName = 'Google AI';

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(`${config.baseUrl || DEFAULT_BASE_URL}/models`, { headers: { 'x-goog-api-key': config.apiKey } }, MODEL_LIST_TIMEOUT_MS);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw createProviderRequestError('Google AI', 'list-models', response.status, providerErrorMessage(data, `Google models request failed: ${response.status}`));
    }
    const data = (await response.json()) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models || []).filter((model) => model.supportedGenerationMethods?.includes('generateContent')).map((model): AIModel => {
      const id = model.name.replace(/^models\//, '');
      const thinking = isThinkingModel(id);
      return { id, name: model.displayName || id, providerId: this.id, capabilities: thinking ? ['text', 'vision', 'streaming', 'tools', 'reasoning'] : ['text', 'vision', 'streaming', 'tools'], reasoningLevels: thinking ? ['low', 'normal', 'high', 'maximum'] : ['normal'] };
    });
  }

  private buildBody(request: AIRequest): Record<string, unknown> {
    const systemMessages = request.messages.filter((message) => message.role === 'system');
    const body: Record<string, unknown> = { systemInstruction: systemMessages.length ? { parts: systemMessages.map((message) => ({ text: message.content })) } : undefined, contents: buildContents(request.messages) };
    if (isGemini3Model(request.model)) body.generationConfig = { thinkingConfig: { thinkingLevel: thinkingLevel(request.intelligence) } };
    else if (isGemini25Model(request.model)) body.generationConfig = { thinkingConfig: { thinkingBudget: thinkingBudget(request.intelligence) } };
    const tools = buildTools(request);
    if (tools) body.tools = tools;
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const response = await fetchWithTimeout(`${config.baseUrl || DEFAULT_BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey }, body: JSON.stringify(this.buildBody(request)) }, REQUEST_TIMEOUT_MS);
    const data = (await response.json()) as GoogleChunk;
    if (!response.ok) throw createProviderRequestError('Google AI', 'send', response.status, data.error?.message || `Google AI request failed: ${response.status}`);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const content = parts.filter((part) => !part.thought && part.text).map((part) => part.text || '').join('');
    return { content, model: request.model, providerId: this.id, usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount, totalTokens: data.usageMetadata?.totalTokenCount }, toolCalls: parseToolCalls(parts) };
  }

  async *stream(config: AIProviderConfig, request: AIRequest): AsyncGenerator<AIStreamEvent> {
    const response = await fetchWithTimeout(`${config.baseUrl || DEFAULT_BASE_URL}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey }, body: JSON.stringify(this.buildBody(request)) }, REQUEST_TIMEOUT_MS);
    if (!response.ok) { const data = await response.json().catch(() => ({})) as GoogleChunk; throw createProviderRequestError('Google AI', 'stream', response.status, data.error?.message || `Google AI streaming request failed: ${response.status}`); }
    let content = '';
    let usage: AIResponse['usage'];
    const toolCalls: AIToolCall[] = [];
    let terminal = false;
    yield { type: 'start' };
    for await (const raw of parseSSE(response)) {
      const chunk = raw as GoogleChunk;
      if (chunk.error?.message) { terminal = true; throw new Error(chunk.error.message); }
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.thought) continue;
        if (part.text) { content += part.text; yield { type: 'delta', text: part.text }; }
        if (part.functionCall) { const parsed = parseToolCalls([part]); for (const call of parsed) { toolCalls.push(call); yield { type: 'tool_call', toolCall: call }; } }
      }
      if (chunk.usageMetadata) usage = { inputTokens: chunk.usageMetadata.promptTokenCount, outputTokens: chunk.usageMetadata.candidatesTokenCount, totalTokens: chunk.usageMetadata.totalTokenCount };
    }
    if (!terminal) { if (content.length === 0 && toolCalls.length === 0 && !usage) throw new Error('Google AI encerrou o streaming sem um evento terminal ou conteúdo.'); terminal = true; }
    const result: AIResponse = { content, model: request.model, providerId: request.providerId, usage, toolCalls };
    yield { type: 'complete', response: result, usage };
  }
}
