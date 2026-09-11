import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../src/ai/provider-registry';
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  OpenAICompatibleAdapter,
  type OpenAICompatibleProviderDescriptor,
} from '../src/ai/providers/openai-compatible';
import { ProviderRequestError } from '../src/ai/provider-errors';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

const request: AIRequest = {
  providerId: 'openrouter',
  model: 'vendor/reasoner',
  messages: [
    { role: 'system', content: 'Follow project rules.' },
    { role: 'user', content: 'Read README.md' },
  ],
  intelligence: 'high',
  toolsEnabled: true,
  tools: [{
    name: 'read_file',
    description: 'Read one file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    requiresWriteAccess: false,
    requiresApproval: false,
  }],
};

function config(providerId = 'openrouter', baseUrl?: string): AIProviderConfig {
  return {
    id: providerId,
    displayName: providerId,
    apiKey: 'test-key',
    ...(baseUrl ? { baseUrl } : {}),
    enabled: true,
  };
}

function descriptor(id: string, overrides: Partial<OpenAICompatibleProviderDescriptor> = {}): OpenAICompatibleProviderDescriptor {
  return {
    id,
    displayName: id,
    baseUrl: `https://${id}.test/v1`,
    toolsByDefault: true,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const payload = typeof event === 'string' ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function withMockedFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function readBody(init?: RequestInit): Record<string, unknown> {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

test('registry exposes every OpenAI-compatible provider descriptor', () => {
  const registry = new ProviderRegistry();
  const ids = new Set(registry.list().map((adapter) => adapter.id));
  assert.equal(OPENAI_COMPATIBLE_PROVIDERS.length, 9);
  for (const provider of OPENAI_COMPATIBLE_PROVIDERS) assert.equal(ids.has(provider.id), true, provider.id);
});

test('model discovery normalizes tools, reasoning, vision and context metadata', async () => {
  const adapter = new OpenAICompatibleAdapter(descriptor('openrouter', { reasoningStyle: 'object' }));
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://openrouter.test/v1/models');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return jsonResponse({
      data: [{
        id: 'vendor/reasoner',
        name: 'Reasoner',
        context_length: 131072,
        supported_parameters: ['tools', 'reasoning'],
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      }],
    });
  }, async () => {
    const [model] = await adapter.listModels(config('openrouter', 'https://openrouter.test/v1/'));
    assert.ok(model);
    assert.equal(model.id, 'vendor/reasoner');
    assert.equal(model.name, 'Reasoner');
    assert.equal(model.contextWindow, 131072);
    assert.deepEqual(model.reasoningLevels, ['low', 'normal', 'high']);
    assert.deepEqual(model.capabilities, ['text', 'streaming', 'tools', 'reasoning', 'vision']);
  });
});

test('Hugging Face derives tool support from provider metadata instead of assuming it globally', async () => {
  const adapter = new OpenAICompatibleAdapter(descriptor('huggingface', { toolsByDefault: false }));
  await withMockedFetch(async () => jsonResponse({
    data: [
      { id: 'tool-model', providers: [{ provider: 'a', supports_tools: true }] },
      { id: 'plain-model', providers: [{ provider: 'b', supports_tools: false }] },
    ],
  }), async () => {
    const models = await adapter.listModels(config('huggingface'));
    assert.equal(models[0]?.capabilities.includes('tools'), true);
    assert.equal(models[1]?.capabilities.includes('tools'), false);
  });
});

test('compatible chat completion maps messages, tools, reasoning and normalized response', async () => {
  const adapter = new OpenAICompatibleAdapter(descriptor('together', {
    reasoningStyle: 'effort',
    reasoningModelPattern: /reasoner/,
  }));
  await withMockedFetch(async (input) => {
    if (String(input).endsWith('/models')) return jsonResponse({ data: [{ id: 'vendor/reasoner' }] });
    throw new Error(`Unexpected discovery request: ${String(input)}`);
  }, async () => {
    await adapter.listModels(config('together'));
  });

  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://together.test/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['Content-Type'], 'application/json');
    const body = readBody(init);
    assert.equal(body.model, 'vendor/reasoner');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal('stream_options' in body, false);
    assert.ok(Array.isArray(body.messages));
    assert.ok(Array.isArray(body.tools));
    return jsonResponse({
      choices: [{
        message: {
          content: 'Done',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    });
  }, async () => {
    const response = await adapter.send(config('together'), { ...request, providerId: 'together' });
    assert.equal(response.content, 'Done');
    assert.equal(response.providerId, 'together');
    assert.deepEqual(response.toolCalls?.[0]?.input, { path: 'README.md' });
    assert.deepEqual(response.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });
});

test('compatible streaming reconstructs fragmented tool calls and completes after finish_reason', async () => {
  const adapter = new OpenAICompatibleAdapter(descriptor('openrouter'));
  await withMockedFetch(async (_input, init) => {
    const body = readBody(init);
    assert.equal(body.stream, true);
    assert.equal('stream_options' in body, false);
    return sseResponse([
      { choices: [{ delta: { content: 'Hello ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'world' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
      '[DONE]',
    ]);
  }, async () => {
    const events = [];
    for await (const event of adapter.stream(config('openrouter'), request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'tool_call', 'complete']);
    assert.equal(events[1]?.text, 'Hello ');
    assert.equal(events[2]?.text, 'world');
    assert.equal(events[3]?.toolCall?.id, 'call_2');
    assert.deepEqual(events[3]?.toolCall?.input, { path: 'README.md' });
    assert.equal(events[4]?.response?.content, 'Hello world');
    assert.deepEqual(events[4]?.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });
});

test('compatible provider respects an explicit base URL override', async () => {
  const adapter = new OpenAICompatibleAdapter(descriptor('groq'));
  await withMockedFetch(async (input) => {
    assert.equal(String(input), 'https://gateway.local/custom/models');
    return jsonResponse({ data: [] });
  }, async () => {
    await adapter.listModels(config('groq', 'https://gateway.local/custom/'));
  });
});

test('compatible provider preserves provider identity and HTTP authentication failures', async () => {
  const adapter = new OpenAICompatibleAdapter(descriptor('deepseek', { displayName: 'DeepSeek' }));
  await withMockedFetch(async () => jsonResponse({ error: { message: 'Invalid API key' } }, 401), async () => {
    await assert.rejects(
      () => adapter.send(config('deepseek'), { ...request, providerId: 'deepseek' }),
      (error: unknown) => error instanceof ProviderRequestError
        && error.provider === 'DeepSeek'
        && error.status === 401
        && error.kind === 'authentication',
    );
  });
});
