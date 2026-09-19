import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

function config(id: string, baseUrl?: string): AIProviderConfig {
  return {
    id,
    displayName: id,
    apiKey: 'test-key',
    ...(baseUrl ? { baseUrl } : {}),
    enabled: true,
  };
}

function request(providerId: string): AIRequest {
  return {
    providerId,
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    intelligence: 'normal',
    toolsEnabled: false,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
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

test('provider registry exposes SambaNova and SiliconFlow', () => {
  const registry = new ProviderRegistry();
  assert.equal(registry.get('sambanova').displayName, 'SambaNova');
  assert.equal(registry.get('siliconflow').displayName, 'SiliconFlow');
});

test('SiliconFlow model discovery requests only chat models', async () => {
  const registry = new ProviderRegistry();
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://api.siliconflow.cn/v1/models?sub_type=chat');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return jsonResponse({
      object: 'list',
      data: [
        { id: 'deepseek-ai/DeepSeek-V4-Flash' },
        { id: 'Pro/zai-org/GLM-5.1', name: 'GLM 5.1 Pro' },
        { id: 'deepseek-ai/DeepSeek-V4-Flash' },
        { id: '' },
      ],
    });
  }, async () => {
    const models = await registry.listModels(config('siliconflow'));
    assert.deepEqual(models.map((model) => model.id), [
      'deepseek-ai/DeepSeek-V4-Flash',
      'Pro/zai-org/GLM-5.1',
    ]);
    assert.equal(models[0]?.providerId, 'siliconflow');
    assert.deepEqual(models[0]?.capabilities, ['text', 'streaming', 'tools']);
    assert.equal(models[1]?.name, 'GLM 5.1 Pro');
  });
});

test('SiliconFlow model discovery respects a compatible custom base URL', async () => {
  const registry = new ProviderRegistry();
  await withMockedFetch(async (input) => {
    assert.equal(String(input), 'https://gateway.example/v1/models?sub_type=chat');
    return jsonResponse({ data: [] });
  }, async () => {
    await registry.listModels(config('siliconflow', 'https://gateway.example/v1/'));
  });
});

test('SambaNova uses OpenAI-compatible chat completions with provider identity preserved', async () => {
  const registry = new ProviderRegistry();
  const adapter = registry.get('sambanova');
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://api.sambanova.ai/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    assert.equal(init?.method, 'POST');
    return jsonResponse({
      choices: [{ message: { content: 'Hello from SambaNova' } }],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    });
  }, async () => {
    const response = await adapter.send(config('sambanova'), request('sambanova'));
    assert.equal(response.providerId, 'sambanova');
    assert.equal(response.content, 'Hello from SambaNova');
    assert.deepEqual(response.usage, { inputTokens: 2, outputTokens: 4, totalTokens: 6 });
  });
});
