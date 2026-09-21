import type {
  AIMessage,
  AIModel,
  AIProviderAdapter,
  AIProviderConfig,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  AIToolCall,
} from '../types';
import { classifyProviderError, createProviderRequestError, retryAfterFromMessage } from '../provider-errors';
import { fetchWithTimeout, parseSSE } from '../sse';

const MODEL_LIST_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const FOUNDRY_STREAM_IDLE_TIMEOUT_MS = 300_000;
const FOUNDRY_MAX_RATE_LIMIT_RETRIES = 8;
const FOUNDRY_MAX_AUTO_RETRY_WAIT_MS = 300_000;
const FOUNDRY_MAX_TOTAL_RATE_LIMIT_WAIT_MS = 600_000;
const FOUNDRY_RETRY_BACKOFF_BASE_MS = 2_000;
const KIMI_K2_6_MAX_COMPLETION_TOKENS = 8_192;

type FoundryRateLimitBudget = {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsAt?: number;
  resetTokensAt?: number;
};

const foundryRateLimitBudgets = new Map<string, FoundryRateLimitBudget>();

function normalizeBaseUrl(value?: string): string {
  const raw = value?.trim().replace(/\/+$/, '');
  if (!raw) throw new Error('Azure Foundry exige a URL base do recurso.');
  if (/\/openai\/v1$/i.test(raw)) return raw;
  if (/\/openai$/i.test(raw)) return `${raw}/v1`;
  return `${raw}/openai/v1`;
}

function usesResponsesApi(model: string): boolean {
  return /^(?:gpt|o[1-9])(?:[-_.]|$)|^chatgpt/i.test(model.trim());
}

function reasoningLevels(model: string): AIRequest['intelligence'][] {
  const id = model.toLowerCase();
  if (/gpt-5\.6(?:-|$)/.test(id)) return ['low', 'normal', 'high', 'maximum'];
  if (/gpt-5-pro(?:-|$)/.test(id)) return ['high'];
  if (/gpt-5(?:\.\d+)?(?:-|$)/.test(id) || /gpt-5-(?:mini|nano|chat|codex)/.test(id)) return ['low', 'normal', 'high'];
  if (/^o[1-9](?:-|$)|deep-research|codex/i.test(id)) return ['low', 'normal', 'high'];
  return ['normal'];
}

function supportsReasoning(model: string): boolean {
  return reasoningLevels(model).some((level) => level !== 'normal');
}

function reasoningEffort(level: AIRequest['intelligence'], model: string): string | undefined {
  if (!supportsReasoning(model) || level === 'normal') return undefined;
  if (level === 'low') return 'low';
  if (level === 'high') return 'high';
  if (level === 'maximum') return reasoningLevels(model).includes('maximum') ? 'max' : 'high';
  return 'medium';
}

function buildResponsesInput(messages: AIMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls || []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) });
      }
      continue;
    }
    input.push({ role: message.role, content: [{ type: 'input_text', text: message.content }] });
  }
  return input;
}

function buildResponsesTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  }));
}

function buildChatMessages(messages: AIMessage[]): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.toolCallId) mapped.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const toolCalls = (message.toolCalls || []).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      }));
      mapped.push({
        role: 'assistant',
        content: message.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    mapped.push({ role: message.role, content: message.content });
  }
  return mapped;
}

function buildChatTools(request: AIRequest): Array<Record<string, unknown>> | undefined {
  if (!request.toolsEnabled || !request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    const record = asRecord(part);
    return typeof record?.text === 'string' ? record.text : '';
  }).join('');
}

function parseResponsesToolCalls(output: unknown): AIToolCall[] {
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

function parseChatToolCall(value: unknown): AIToolCall | undefined {
  const record = asRecord(value);
  const fn = asRecord(record?.function);
  if (typeof record?.id !== 'string' || typeof fn?.name !== 'string') return undefined;
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return { id: record.id, name: fn.name as AIToolCall['name'], input };
}

function parseChatToolCalls(value: unknown): AIToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseChatToolCall).filter((item): item is AIToolCall => Boolean(item));
}

function normalizeEmbeddedToolName(raw: string, request: AIRequest): string | undefined {
  const compact = raw
    .replace(/^functions\./i, '')
    .replace(/:[^:<>]+$/u, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  if (!compact) return undefined;
  return request.tools?.find((tool) => tool.name.replace(/[^a-z0-9]/gi, '').toLowerCase() === compact)?.name;
}

function normalizeEmbeddedToolInput(name: string, input: Record<string, unknown>, request: AIRequest): Record<string, unknown> {
  if (name !== 'plan_execution' || !Array.isArray(input.plan) || 'steps' in input) return input;
  const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')?.content?.trim();
  const { plan, ...rest } = input;
  return {
    ...rest,
    objective: typeof input.objective === 'string' && input.objective.trim()
      ? input.objective
      : lastUser || 'Executar a tarefa solicitada pelo usuário.',
    steps: plan,
  };
}

function containsEmbeddedToolProtocol(content: string): boolean {
  return /<\|toolcalls?sectionbegin\|>|<\|toolcallbegin\|>/i.test(content);
}

function retryWithoutToolProtocol(request: AIRequest): AIRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'system',
        content: 'A tentativa anterior tentou emitir um protocolo interno de ferramenta, mas este request não possui ferramentas. Responda agora somente com a resposta final em texto normal. Não escreva tokens de controle, nomes de funções, argumentos JSON ou qualquer formato de chamada de ferramenta.',
      },
    ],
    toolsEnabled: false,
    tools: undefined,
  };
}

function extractEmbeddedToolCalls(content: string, request: AIRequest): { content: string; toolCalls: AIToolCall[] } {
  if (!content.includes('<|toolcall')) return { content, toolCalls: [] };
  const calls: AIToolCall[] = [];
  const pattern = /<\|toolcallbegin\|>\s*([^<]+?)<\|toolcallargumentbegin\|>([\s\S]*?)<\|toolcallend\|>/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(content)) !== null) {
    const name = normalizeEmbeddedToolName(match[1].trim(), request);
    if (!name) continue;
    try {
      const parsed = JSON.parse(match[2].trim() || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const input = normalizeEmbeddedToolInput(name, parsed as Record<string, unknown>, request);
      calls.push({
        id: `foundry-embedded-${Date.now().toString(36)}-${index++}`,
        name: name as AIToolCall['name'],
        input,
      });
    } catch {
      continue;
    }
  }

  const visible = content
    .replace(/<\|toolcalls?sectionbegin\|>[\s\S]*?<\|toolcalls?sectionend\|>/gi, '')
    .replace(/<\|toolcallbegin\|>[\s\S]*?<\|toolcallend\|>/gi, '')
    .trim();
  return { content: visible, toolCalls: calls };
}

function mergeToolCalls(primary: AIToolCall[], fallback: AIToolCall[]): AIToolCall[] {
  if (!fallback.length) return primary;
  const signatures = new Set(primary.map((call) => `${call.name}:${JSON.stringify(call.input)}`));
  const merged = [...primary];
  for (const call of fallback) {
    const signature = `${call.name}:${JSON.stringify(call.input)}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    merged.push(call);
  }
  return merged;
}

function responsesUsage(value: unknown): AIResponse['usage'] | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function chatUsage(value: unknown): AIResponse['usage'] | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function providerErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const error = (value as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  const responseError = (value as { response?: { error?: { message?: unknown } } }).response?.error?.message;
  return typeof responseError === 'string' && responseError.trim() ? responseError : fallback;
}

function headers(config: AIProviderConfig): Record<string, string> {
  return {
    'api-key': config.apiKey,
    'Content-Type': 'application/json',
  };
}

function retryAfterMs(response: Response): number | undefined {
  const retryAfterMsHeader = response.headers.get('retry-after-ms') || response.headers.get('x-ms-retry-after-ms');
  if (retryAfterMsHeader) {
    const parsed = Number(retryAfterMsHeader);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function finiteHeaderNumber(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function durationHeaderMs(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name)?.trim().toLowerCase();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;

  let total = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    matched = true;
    const value = Number(match[1]);
    if (match[2] === 'ms') total += value;
    else if (match[2] === 's') total += value * 1000;
    else if (match[2] === 'm') total += value * 60_000;
    else total += value * 3_600_000;
  }
  return matched ? total : undefined;
}

function rateLimitBudget(response: Response, now = Date.now()): FoundryRateLimitBudget {
  const resetRequestsMs = durationHeaderMs(response, 'x-ratelimit-reset-requests');
  const resetTokensMs = durationHeaderMs(response, 'x-ratelimit-reset-tokens');
  return {
    limitRequests: finiteHeaderNumber(response, 'x-ratelimit-limit-requests'),
    limitTokens: finiteHeaderNumber(response, 'x-ratelimit-limit-tokens'),
    remainingRequests: finiteHeaderNumber(response, 'x-ratelimit-remaining-requests'),
    remainingTokens: finiteHeaderNumber(response, 'x-ratelimit-remaining-tokens'),
    ...(resetRequestsMs !== undefined ? { resetRequestsAt: now + resetRequestsMs } : {}),
    ...(resetTokensMs !== undefined ? { resetTokensAt: now + resetTokensMs } : {}),
  };
}

function hasRateLimitMetadata(value: FoundryRateLimitBudget): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

function requestRateLimitKey(input: RequestInfo | URL, init: RequestInit): string {
  let model = '';
  if (typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as { model?: unknown };
      if (typeof parsed.model === 'string') model = parsed.model.trim();
    } catch {
    }
  }
  return `${String(input)}::${model}`;
}

function estimatedRequestTokens(init: RequestInit): number {
  if (typeof init.body !== 'string') return 0;
  let maximumOutput = 0;
  try {
    const parsed = JSON.parse(init.body) as { max_completion_tokens?: unknown; max_tokens?: unknown };
    const candidate = typeof parsed.max_completion_tokens === 'number'
      ? parsed.max_completion_tokens
      : typeof parsed.max_tokens === 'number'
        ? parsed.max_tokens
        : 0;
    if (Number.isFinite(candidate) && candidate > 0) maximumOutput = candidate;
  } catch {
  }
  return Math.ceil(init.body.length / 4) + maximumOutput;
}

function knownBudgetWaitMs(budget: FoundryRateLimitBudget | undefined, estimatedTokens: number, now = Date.now()): number {
  if (!budget) return 0;
  const waits: number[] = [];
  if (budget.remainingRequests !== undefined && budget.remainingRequests < 1 && budget.resetRequestsAt) {
    waits.push(Math.max(0, budget.resetRequestsAt - now));
  }
  if (estimatedTokens > 0 && budget.remainingTokens !== undefined && budget.remainingTokens < estimatedTokens && budget.resetTokensAt) {
    waits.push(Math.max(0, budget.resetTokensAt - now));
  }
  return waits.length ? Math.max(...waits) + 250 : 0;
}

function responseResetWaitMs(response: Response): number | undefined {
  const budget = rateLimitBudget(response);
  const waits = [
    budget.resetRequestsAt ? Math.max(0, budget.resetRequestsAt - Date.now()) : undefined,
    budget.resetTokensAt ? Math.max(0, budget.resetTokensAt - Date.now()) : undefined,
  ].filter((value): value is number => value !== undefined);
  return waits.length ? Math.max(...waits) + 250 : undefined;
}

function rateLimitDiagnostic(response: Response, message: string): Record<string, unknown> {
  const budget = rateLimitBudget(response);
  return {
    status: response.status,
    message: message.slice(0, 240),
    retryAfterMs: retryAfterMs(response),
    limitRequests: budget.limitRequests,
    remainingRequests: budget.remainingRequests,
    limitTokens: budget.limitTokens,
    remainingTokens: budget.remainingTokens,
    resetRequestsMs: budget.resetRequestsAt ? Math.max(0, budget.resetRequestsAt - Date.now()) : undefined,
    resetTokensMs: budget.resetTokensAt ? Math.max(0, budget.resetTokensAt - Date.now()) : undefined,
  };
}

async function rateLimitMessage(response: Response): Promise<string> {
  try {
    const text = await response.clone().text();
    if (!text.trim()) return '';
    try {
      return providerErrorMessage(JSON.parse(text), text);
    } catch {
      return text.trim();
    }
  } catch {
    return '';
  }
}

function fallbackRetryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return FOUNDRY_RETRY_BACKOFF_BASE_MS * (2 ** (attempt - 1));
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  signal?.throwIfAborted();
}

async function fetchFoundryWithRateLimitRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response | undefined;
  let totalWaitMs = 0;
  const budgetKey = requestRateLimitKey(input, init);
  const estimatedTokens = estimatedRequestTokens(init);
  const proactiveWaitMs = knownBudgetWaitMs(foundryRateLimitBudgets.get(budgetKey), estimatedTokens);
  if (proactiveWaitMs > 0 && proactiveWaitMs <= FOUNDRY_MAX_AUTO_RETRY_WAIT_MS) {
    await waitForRetry(proactiveWaitMs, signal);
  }

  for (let attempt = 0; attempt <= FOUNDRY_MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    response = await fetchWithTimeout(input, { ...init, signal }, timeoutMs);
    if (response.status !== 429) {
      const budget = rateLimitBudget(response);
      if (hasRateLimitMetadata(budget)) foundryRateLimitBudgets.set(budgetKey, budget);
      return response;
    }

    const message = await rateLimitMessage(response);
    const kind = classifyProviderError(response.status, message || 'Too many requests');
    const suggestedDelayMs = retryAfterMs(response)
      ?? retryAfterFromMessage(message)
      ?? responseResetWaitMs(response);
    const delayMs = suggestedDelayMs ?? Math.min(60_000, fallbackRetryDelayMs(attempt));
    const canRetry = attempt < FOUNDRY_MAX_RATE_LIMIT_RETRIES
      && kind === 'rate_limit'
      && delayMs <= FOUNDRY_MAX_AUTO_RETRY_WAIT_MS
      && totalWaitMs + delayMs <= FOUNDRY_MAX_TOTAL_RATE_LIMIT_WAIT_MS;

    if (!canRetry) {
      console.warn('[Auto CodeZ Azure rate limit]', JSON.stringify(rateLimitDiagnostic(response, message)));
      return response;
    }

    try {
      await response.body?.cancel();
    } catch {
      // Best effort only. The retry still uses a fresh request.
    }
    totalWaitMs += delayMs;
    await waitForRetry(delayMs, signal);
  }

  return response!;
}

export class AzureOpenAIAdapter implements AIProviderAdapter {
  readonly id = 'azure-openai';
  readonly displayName = 'Azure Foundry';

  async listModels(config: AIProviderConfig): Promise<AIModel[]> {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(config.baseUrl)}/models`,
      { headers: { 'api-key': config.apiKey } },
      MODEL_LIST_TIMEOUT_MS,
    );
    const data = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) {
      throw createProviderRequestError(
        this.displayName,
        'list-models',
        response.status,
        data.error?.message || `Azure Foundry models request failed: ${response.status}`,
      );
    }
    return (data.data || [])
      .map((model) => typeof model.id === 'string' ? model.id.trim() : '')
      .filter(Boolean)
      .map((id): AIModel => ({
        id,
        name: id,
        providerId: this.id,
        capabilities: ['text', 'streaming', 'tools', ...(supportsReasoning(id) ? ['reasoning'] : [])] as AIModel['capabilities'],
        reasoningLevels: reasoningLevels(id),
      }));
  }

  private buildResponsesBody(request: AIRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: buildResponsesInput(request.messages),
    };
    const effort = reasoningEffort(request.intelligence, request.model);
    if (effort) body.reasoning = { effort };
    const tools = buildResponsesTools(request);
    if (tools) body.tools = tools;
    if (stream) body.stream = true;
    return body;
  }

  private buildChatBody(request: AIRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: buildChatMessages(request.messages),
    };
    if (/^Kimi-K2\.6(?:$|[-_.])/i.test(request.model.trim())) {
      body.max_completion_tokens = KIMI_K2_6_MAX_COMPLETION_TOKENS;
    }
    const tools = buildChatTools(request);
    if (tools) body.tools = tools;
    if (stream) body.stream = true;
    return body;
  }

  async send(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    if (!usesResponsesApi(request.model)) return this.sendChatCompletion(config, request, signal);

    const response = await fetchFoundryWithRateLimitRetry(
      `${normalizeBaseUrl(config.baseUrl)}/responses`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(this.buildResponsesBody(request)),
        signal,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    const data = await response.json().catch(() => ({})) as {
      output_text?: string;
      output?: unknown;
      error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    if (!response.ok) {
      throw createProviderRequestError(
        this.displayName,
        'send',
        response.status,
        data.error?.message || `Azure Foundry Responses request failed: ${response.status}`,
        retryAfterMs(response),
      );
    }
    return {
      content: data.output_text || '',
      model: request.model,
      providerId: this.id,
      usage: responsesUsage(data.usage),
      toolCalls: parseResponsesToolCalls(data.output),
    };
  }

  private async sendChatCompletion(
    config: AIProviderConfig,
    request: AIRequest,
    signal?: AbortSignal,
    protocolRetry = false,
  ): Promise<AIResponse> {
    const response = await fetchFoundryWithRateLimitRetry(
      `${normalizeBaseUrl(config.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(this.buildChatBody(request)),
        signal,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw createProviderRequestError(
        this.displayName,
        'send',
        response.status,
        providerErrorMessage(data, `Azure Foundry chat request failed: ${response.status}`),
        retryAfterMs(response),
      );
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    const rawContent = contentText(message?.content);
    const nativeToolCalls = parseChatToolCalls(message?.tool_calls);
    const protocolAttempt = containsEmbeddedToolProtocol(rawContent) || nativeToolCalls.length > 0;
    if (!request.toolsEnabled && protocolAttempt) {
      if (protocolRetry) {
        throw new Error('Azure Foundry insistiu em emitir uma chamada de ferramenta em um request textual sem ferramentas.');
      }
      return this.sendChatCompletion(config, retryWithoutToolProtocol(request), signal, true);
    }
    const embedded = extractEmbeddedToolCalls(rawContent, request);
    return {
      content: embedded.content,
      model: request.model,
      providerId: this.id,
      usage: chatUsage(data.usage),
      toolCalls: mergeToolCalls(nativeToolCalls, embedded.toolCalls),
    };
  }

  async *stream(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<AIStreamEvent> {
    if (!usesResponsesApi(request.model)) {
      yield* this.streamChatCompletion(config, request, signal);
      return;
    }

    const response = await fetchFoundryWithRateLimitRetry(
      `${normalizeBaseUrl(config.baseUrl)}/responses`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(this.buildResponsesBody(request, true)),
        signal,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw createProviderRequestError(
        this.displayName,
        'stream',
        response.status,
        providerErrorMessage(data, `Azure Foundry Responses streaming request failed: ${response.status}`),
        retryAfterMs(response),
      );
    }

    let content = '';
    let usage: AIResponse['usage'];
    const toolCalls = new Map<string, AIToolCall>();
    const toolCallKeysByOutputIndex = new Map<number, string>();
    let terminal = false;
    yield { type: 'start' };

    for await (const raw of parseSSE(response, FOUNDRY_STREAM_IDLE_TIMEOUT_MS)) {
      const event = raw as {
        type?: string;
        delta?: string;
        item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string };
        item_id?: string;
        output_index?: number;
        arguments?: string;
        response?: {
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
          error?: { message?: string };
        };
        error?: { message?: string } | string;
      };

      if (event.type === 'response.output_text.delta' && event.delta) {
        content += event.delta;
        yield { type: 'delta', text: event.delta };
      }

      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item.call_id && event.item.name) {
        const key = event.item.id || event.item.call_id;
        toolCalls.set(key, { id: event.item.call_id, name: event.item.name as AIToolCall['name'], input: {} });
        if (typeof event.output_index === 'number') toolCallKeysByOutputIndex.set(event.output_index, key);
      }

      if (event.type === 'response.function_call_arguments.done') {
        const key = event.item_id
          || (typeof event.output_index === 'number' ? toolCallKeysByOutputIndex.get(event.output_index) : undefined)
          || event.item?.call_id;
        const existing = key ? toolCalls.get(key) : undefined;
        if (existing) {
          try {
            const parsed = JSON.parse(event.arguments ?? event.item?.arguments ?? '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing.input = parsed as Record<string, unknown>;
          } catch {
            throw new Error('Azure Foundry retornou argumentos inválidos para uma ferramenta.');
          }
          yield { type: 'tool_call', toolCall: existing };
        }
      }

      if (event.type === 'response.completed') {
        terminal = true;
        if (event.response) usage = responsesUsage(event.response.usage);
      }

      if (event.type === 'response.failed') {
        terminal = true;
        throw new Error(providerErrorMessage(event, 'Azure Foundry encerrou o streaming com falha.'));
      }
      if (event.type === 'error') {
        terminal = true;
        throw new Error(providerErrorMessage(event, 'Azure Foundry retornou um erro durante o streaming.'));
      }
    }

    if (!terminal) throw new Error('Azure Foundry encerrou o streaming sem um evento terminal.');
    const result: AIResponse = {
      content,
      model: request.model,
      providerId: this.id,
      usage,
      toolCalls: [...toolCalls.values()],
    };
    yield { type: 'complete', response: result, usage };
  }

  private async *streamChatCompletion(
    config: AIProviderConfig,
    request: AIRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AIStreamEvent> {
    const response = await fetchFoundryWithRateLimitRetry(
      `${normalizeBaseUrl(config.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify(this.buildChatBody(request, true)),
        signal,
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw createProviderRequestError(
        this.displayName,
        'stream',
        response.status,
        providerErrorMessage(data, `Azure Foundry chat streaming request failed: ${response.status}`),
        retryAfterMs(response),
      );
    }

    let content = '';
    let usage: AIResponse['usage'];
    let terminal = false;
    let visibleBuffer = '';
    let embeddedProtocolStarted = false;
    const guardEmbeddedProtocol = !request.toolsEnabled && /^Kimi-K2\.6(?:$|[-_.])/i.test(request.model.trim());
    const embeddedMarkers = ['<|toolcallssectionbegin|>', '<|toolcallsectionbegin|>', '<|toolcallbegin|>'];
    const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
    yield { type: 'start' };

    for await (const raw of parseSSE(response, FOUNDRY_STREAM_IDLE_TIMEOUT_MS)) {
      const chunk = asRecord(raw) ?? {};
      if (chunk.error) throw new Error(providerErrorMessage(chunk, 'Azure Foundry retornou um erro durante o streaming.'));
      const nextUsage = chatUsage(chunk.usage);
      if (nextUsage) usage = nextUsage;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choiceValue of choices) {
        const choice = asRecord(choiceValue);
        const delta = asRecord(choice?.delta);
        const text = contentText(delta?.content);
        if (text) {
          content += text;
          if (!guardEmbeddedProtocol && !embeddedProtocolStarted) {
            visibleBuffer += text;
            const markerIndex = embeddedMarkers
              .map((marker) => visibleBuffer.indexOf(marker))
              .filter((index) => index >= 0)
              .sort((left, right) => left - right)[0];
            if (markerIndex !== undefined) {
              const visible = visibleBuffer.slice(0, markerIndex);
              if (visible) yield { type: 'delta', text: visible };
              visibleBuffer = '';
              embeddedProtocolStarted = true;
            } else {
              let holdLength = 0;
              for (const marker of embeddedMarkers) {
                const maxPrefix = Math.min(marker.length - 1, visibleBuffer.length);
                for (let length = 1; length <= maxPrefix; length += 1) {
                  if (visibleBuffer.endsWith(marker.slice(0, length))) holdLength = Math.max(holdLength, length);
                }
              }
              const safeLength = visibleBuffer.length - holdLength;
              if (safeLength > 0) {
                const visible = visibleBuffer.slice(0, safeLength);
                visibleBuffer = visibleBuffer.slice(safeLength);
                if (visible) yield { type: 'delta', text: visible };
              }
            }
          }
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const callValue of delta.tool_calls) {
            const call = asRecord(callValue);
            const index = typeof call?.index === 'number' ? call.index : 0;
            const fn = asRecord(call?.function);
            const current = pendingCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (typeof call?.id === 'string') current.id = call.id;
            if (typeof fn?.name === 'string') current.name += fn.name;
            if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
            pendingCalls.set(index, current);
          }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) terminal = true;
      }
    }

    if (!guardEmbeddedProtocol && !embeddedProtocolStarted && visibleBuffer) {
      yield { type: 'delta', text: visibleBuffer };
      visibleBuffer = '';
    }
    if (!terminal) throw new Error('Azure Foundry encerrou o streaming sem um evento terminal.');
    const toolCalls: AIToolCall[] = [];
    for (const [, call] of [...pendingCalls.entries()].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) continue;
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.arguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid tool input');
        input = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`Azure Foundry retornou argumentos inválidos para uma ferramenta (${call.name || 'desconhecida'}, ${call.arguments.length} caracteres recebidos).`);
      }
      const toolCall: AIToolCall = { id: call.id, name: call.name as AIToolCall['name'], input };
      toolCalls.push(toolCall);
      yield { type: 'tool_call', toolCall };
    }

    const embedded = extractEmbeddedToolCalls(content, request);
    const protocolAttempt = containsEmbeddedToolProtocol(content) || toolCalls.length > 0;
    if (guardEmbeddedProtocol && protocolAttempt) {
      const retry = await this.sendChatCompletion(config, retryWithoutToolProtocol(request), signal, true);
      if (retry.content) yield { type: 'delta', text: retry.content };
      yield { type: 'complete', response: retry, usage: retry.usage };
      return;
    }
    if (guardEmbeddedProtocol && embedded.content) {
      yield { type: 'delta', text: embedded.content };
    }
    for (const toolCall of embedded.toolCalls) yield { type: 'tool_call', toolCall };
    const result: AIResponse = {
      content: embedded.content,
      model: request.model,
      providerId: this.id,
      usage,
      toolCalls: mergeToolCalls(toolCalls, embedded.toolCalls),
    };
    yield { type: 'complete', response: result, usage };
  }
}
