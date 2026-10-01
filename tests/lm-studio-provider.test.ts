import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../src/ai/provider-registry';
import { LMStudioProviderAdapter } from '../src/ai/providers/lm-studio';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

function config(baseUrl?: string): AIProviderConfig {
  return {
    id: 'lm-studio',
    displayName: 'LM Studio',
    apiKey: '',
    ...(baseUrl ? { baseUrl } : {}),
    enabled: true,
  };
}

const request: AIRequest = {
  providerId: 'lm-studio',
  model: 'granite-local',
  messages: [
    { role: 'system', content: 'Follow project rules.' },
    { role: 'user', content: 'Read README.md' },
  ],
  intelligence: 'normal',
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

async function withoutEnvironmentToken(action: () => Promise<void>): Promise<void> {
  const previous = process.env.LM_API_TOKEN;
  delete process.env.LM_API_TOKEN;
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.LM_API_TOKEN;
    else process.env.LM_API_TOKEN = previous;
  }
}

test('provider registry exposes LM Studio as a keyless local provider', () => {
  const registry = new ProviderRegistry();
  const adapter = registry.get('lm-studio');
  assert.equal(adapter.displayName, 'LM Studio');
  assert.equal(adapter.requiresApiKey, false);
  assert.deepEqual(adapter.fallbackCapabilities, ['text', 'streaming']);
});

test('LM Studio provider discovers only local LLMs through the native API', async () => {
  const adapter = new LMStudioProviderAdapter({ endpoint: 'http://127.0.0.1:1234', apiToken: 'local-token' });
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:1234/api/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-token');
    return jsonResponse({
      models: [
        {
          type: 'llm',
          key: 'granite-local',
          display_name: 'Granite Local',
          size_bytes: 1_800_000_000,
          params_string: '3B',
          max_context_length: 32768,
          capabilities: { vision: true, trained_for_tool_use: true },
        },
        {
          type: 'embedding',
          key: 'embedding-local',
          display_name: 'Embedding Local',
          max_context_length: 8192,
        },
      ],
    });
  }, async () => {
    const models = await adapter.listModels(config('http://127.0.0.1:1234/v1/'));
    assert.deepEqual(models, [{
      id: 'granite-local',
      name: 'Granite Local',
      providerId: 'lm-studio',
      capabilities: ['text', 'streaming', 'tools', 'vision'],
      contextWindow: 32768,
      reasoningLevels: ['normal'],
    }]);
  });
});

test('LM Studio chat remains keyless by default and preserves tool calls', async () => {
  await withoutEnvironmentToken(async () => {
    const adapter = new LMStudioProviderAdapter({ endpoint: 'http://127.0.0.1:1234' });
    await withMockedFetch(async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:1234/v1/chat/completions');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      assert.equal(body.model, 'granite-local');
      assert.ok(Array.isArray(body.tools));
      assert.equal(body.stream, undefined);
      return jsonResponse({
        choices: [{
          message: {
            content: 'Done',
            tool_calls: [{
              id: 'call_local',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      });
    }, async () => {
      const response = await adapter.send(config(), request);
      assert.equal(response.content, 'Done');
      assert.equal(response.providerId, 'lm-studio');
      assert.equal(response.model, 'granite-local');
      assert.deepEqual(response.toolCalls?.[0], {
        id: 'call_local',
        name: 'read_file',
        input: { path: 'README.md' },
      });
      assert.deepEqual(response.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    });
  });
});

test('LM Studio streaming uses the optional local token without changing provider identity', async () => {
  const adapter = new LMStudioProviderAdapter({ endpoint: 'http://127.0.0.1:1234', apiToken: 'local-token' });
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-token');
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    assert.equal(body.stream, true);
    return sseResponse([
      { choices: [{ delta: { content: 'Olá ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'local' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
      '[DONE]',
    ]);
  }, async () => {
    const events = [];
    for await (const event of adapter.stream(config(), request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'complete']);
    assert.equal(events[1]?.text, 'Olá ');
    assert.equal(events[2]?.text, 'local');
    assert.equal(events[3]?.response?.providerId, 'lm-studio');
    assert.equal(events[3]?.response?.content, 'Olá local');
    assert.deepEqual(events[3]?.usage, { inputTokens: 2, outputTokens: 2, totalTokens: 4 });
  });
});
