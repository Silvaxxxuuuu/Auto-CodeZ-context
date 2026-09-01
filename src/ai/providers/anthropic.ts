import type { AIMessage, AIModel, AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, AIStreamEvent, AIToolCall } from '../types';
import { fetchWithTimeout, parseSSE } from '../sse';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const MODEL_LIST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

function supportsEffort(model: string): boolean {
  return /claude-(?:opus|sonnet)-5(?:[-.]|$)|claude-(?:opus|sonnet)-4-(?:6|7|8)(?:[-.]|$)/i.test(model);
}
function effort(level: AIRequest['intelligence']): string { if (level === 'low') return 'low'; if (level === 'normal') return 'medium'; if (level === 'high') return 'high'; return 'max'; }
function buildMessages(messages: AIMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const content: Array<Record<string, unknown>> = [];
      while (index < messages.length && messages[index].role === 'tool') {
        const toolMessage = messages[index];
        if (toolMessage.toolCallId) content.push({ type: 'tool_result', tool_use_id: toolMessage.toolCallId, content: toolMessage.content });
        index += 1;
      }
      index -= 1;
      if (content.length) result.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      result.push({ role: 'assistant', content });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}
function buildTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}
type AnthropicEvent = { type?: string; index?: number; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; id?: string; name?: string }; message?: { usage?: { input_tokens?: number; output_tokens?: number } }; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
function parseToolBlocks(content: Array<{ type?: string; id?: string; name?: string; input?: unknown }>): AIToolCall[] {
  return content.flatMap((item) => { if (item.type !== 'tool_use' || !item.id || !item.name) return []; const input = item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input as Record<string, unknown> : {}; return [{ id: item.id, name: item.name as AIToolCall['name'], input }]; });
}
function providerErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const error = (value as { error?: unknown }).error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export class AnthropicAdapter implements AIProviderAdapter {
  readonly id = 'anthropic'; readonly displayName = 'Anthropic';
  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(`${config.baseUrl || DEFAULT_BASE_URL}/models`, { headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } }, MODEL_LIST_TIMEOUT_MS);
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(providerErrorMessage(data, `Anthropic models request failed: ${response.status}`)); }
    const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (data.data || []).map((model): AIModel => ({ id: model.id, name: model.display_name || model.id, providerId: this.id, capabilities: ['text', 'vision', 'streaming', 'tools', ...(supportsEffort(model.id) ? ['reasoning'] : [])] as AIModel['capabilities'], reasoningLevels: supportsEffort(model.id) ? ['low', 'normal', 'high', 'maximum'] : ['normal'] }));
  }
  private buildBody(request: AIRequest, stream = false): Record<string, unknown> {
    const systemMessages = request.messages.filter((message) => message.role === 'system');
    const body: Record<string, unknown> = { model: request.model, max_tokens: 8192, system: systemMessages.map((message) => message.content).join('\n\n') || undefined, messages: buildMessages(request.messages), stream };
    const tools = buildTools(request); if (tools) body.tools = tools; if (supportsEffort(request.model)) body.output_config = { effort: effort(request.intelligence) }; return body;
  }
  async send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
    const response = await fetchWithTimeout(`${config.baseUrl || DEFAULT_BASE_URL}/messages`, { method: 'POST', headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(this.buildBody(request)) }, REQUEST_TIMEOUT_MS);
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>; error?: { message?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
    if (!response.ok) throw new Error(data.error?.message || `Anthropic request failed: ${response.status}`);
    return { content: data.content?.filter((item) => item.type === 'text').map((item) => item.text || '').join('') || '', model: request.model, providerId: this.id, usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens, totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) }, toolCalls: parseToolBlocks(data.content || []) };
  }
  async *stream(config: AIProviderConfig, request: AIRequest): AsyncGenerator<AIStreamEvent> {
    const response = await fetchWithTimeout(`${config.baseUrl || DEFAULT_BASE_URL}/messages`, { method: 'POST', headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(this.buildBody(request, true)) }, REQUEST_TIMEOUT_MS);
    if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: { message?: string } }; throw new Error(data.error?.message || `Anthropic streaming request failed: ${response.status}`); }
    let content = ''; let usage: AIResponse['usage']; const toolCalls: AIToolCall[] = []; let activeTool: { id: string; name: string; json: string } | undefined; let terminal = false; yield { type: 'start' };
    for await (const raw of parseSSE(response)) {
      const event = raw as AnthropicEvent;
      if (event.type === 'error' && event.error?.message) { terminal = true; throw new Error(event.error.message); }
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.content_block.id && event.content_block.name) activeTool = { id: event.content_block.id, name: event.content_block.name, json: '' };
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) { content += event.delta.text; yield { type: 'delta', text: event.delta.text }; }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && activeTool) activeTool.json += event.delta.partial_json || '';
      if (event.type === 'content_block_stop' && activeTool) { let input: Record<string, unknown> = {}; try { const parsed = JSON.parse(activeTool.json || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>; } catch { throw new Error('Anthropic retornou argumentos inválidos para uma ferramenta.'); } const call: AIToolCall = { id: activeTool.id, name: activeTool.name as AIToolCall['name'], input }; toolCalls.push(call); yield { type: 'tool_call', toolCall: call }; activeTool = undefined; }
      if (event.type === 'message_start' && event.message?.usage) usage = { inputTokens: event.message.usage.input_tokens, outputTokens: event.message.usage.output_tokens };
      if (event.type === 'message_delta' && event.usage) usage = { inputTokens: usage?.inputTokens, outputTokens: event.usage.output_tokens, totalTokens: (usage?.inputTokens || 0) + (event.usage.output_tokens || 0) };
      if (event.type === 'message_stop') terminal = true;
    }
    if (!terminal) throw new Error('Anthropic encerrou o streaming sem um evento terminal.');
    const result: AIResponse = { content, model: request.model, providerId: request.providerId, usage, toolCalls }; yield { type: 'complete', response: result, usage };
  }
}
