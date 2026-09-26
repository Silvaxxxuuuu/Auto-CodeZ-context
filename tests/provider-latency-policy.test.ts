import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleAdapter } from '../src/ai/providers/google';
import { OpenAICompatibleAdapter } from '../src/ai/providers/openai-compatible';
import { formatProviderError, ProviderRequestError } from '../src/ai/provider-errors';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'google',
  displayName: 'Google AI',
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1beta',
  enabled: true,
};

function request(intelligence: AIRequest['intelligence']): AIRequest {
  return {
    providerId: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Hello' }],
    intelligence,
    toolsEnabled: false,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockedFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>, action: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function bodyFrom(init?: RequestInit): Record<string, unknown> {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function thinkingBudgetFrom(body: Record<string, unknown>): number | undefined {
  const generation = body.generationConfig as { thinkingConfig?: { thinkingBudget?: number } } | undefined;
  return generation?.thinkingConfig?.thinkingBudget;
}

test('Gemini 2.5 normal intelligence uses dynamic reasoning instead of forcing 8192 thinking tokens', async () => {
  await withMockedFetch(async (_input, init) => {
    assert.equal(thinkingBudgetFrom(bodyFrom(init)), -1);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  }, async () => {
    await new GoogleAdapter().send(config, request('normal'));
  });
});

test('Gemini 2.5 explicit intelligence levels retain bounded reasoning budgets', async () => {
  const expected = new Map<AIRequest['intelligence'], number>([
    ['low', 1024],
    ['high', 8192],
    ['maximum', 24576],
  ]);

  for (const [level, budget] of expected) {
    await withMockedFetch(async (_input, init) => {
      assert.equal(thinkingBudgetFrom(bodyFrom(init)), budget);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }, async () => {
      await new GoogleAdapter().send(config, request(level));
    });
  }
});

test('OpenAI-compatible request body hooks can disable local thinking without changing shared transport', async () => {
  const adapter = new OpenAICompatibleAdapter({
    id: 'managed-local-test',
    displayName: 'Managed Local Test',
    baseUrl: 'http://127.0.0.1:9999/v1',
    toolsByDefault: true,
    requestBodyExtras: (input) => ({
      chat_template_kwargs: { enable_thinking: input.intelligence === 'high' },
      max_tokens: 2048,
    }),
  });
  const localConfig: AIProviderConfig = {
    id: 'managed-local-test',
    displayName: 'Managed Local Test',
    apiKey: '',
    enabled: true,
  };
  const localRequest: AIRequest = {
    providerId: 'managed-local-test',
    model: 'qwen3-test',
    messages: [{ role: 'user', content: 'Oi' }],
    intelligence: 'normal',
    toolsEnabled: false,
  };

  await withMockedFetch(async (_input, init) => {
    const body = bodyFrom(init);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.max_tokens, 2048);
    return jsonResponse({ choices: [{ message: { content: 'Oi!' } }] });
  }, async () => {
    const response = await adapter.send(localConfig, localRequest);
    assert.equal(response.content, 'Oi!');
  });
});

test('temporary provider errors preserve HTTP status and bounded provider detail', () => {
  const message = formatProviderError(new ProviderRequestError('Service overloaded in this region', 503, 'Google AI'));
  assert.match(message, /HTTP 503/);
  assert.match(message, /Service overloaded in this region/);
});
