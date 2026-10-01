import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelResolver } from '../src/ai/model-resolver';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderConfig } from '../src/ai/types';

function config(apiKey: string): AIProviderConfig {
  return { id: 'openai', displayName: 'OpenAI', apiKey, enabled: true };
}

test('model discovery cache is isolated between API keys of the same provider', async () => {
  const registry = new ProviderRegistry();
  let calls = 0;
  registry.register({
    id: 'openai',
    displayName: 'OpenAI',
    listModels: async (providerConfig) => {
      calls += 1;
      return [{
        id: providerConfig.apiKey === 'key-a' ? 'model-a' : 'model-b',
        name: providerConfig.apiKey === 'key-a' ? 'Model A' : 'Model B',
        providerId: 'openai',
        capabilities: ['text', 'streaming', 'tools'],
      }];
    },
    send: async () => ({ content: '', model: 'unused', providerId: 'openai' }),
  });

  const resolver = new ModelResolver(registry);
  const first = await resolver.list(config('key-a'));
  const second = await resolver.list(config('key-b'));

  assert.equal(calls, 2);
  assert.equal(first[0]?.id, 'model-a');
  assert.equal(second[0]?.id, 'model-b');
});

test('model discovery still reuses cache for the same credential and base URL', async () => {
  const registry = new ProviderRegistry();
  let calls = 0;
  registry.register({
    id: 'openai',
    displayName: 'OpenAI',
    listModels: async () => {
      calls += 1;
      return [{ id: 'model-a', name: 'Model A', providerId: 'openai', capabilities: ['text'] }];
    },
    send: async () => ({ content: '', model: 'unused', providerId: 'openai' }),
  });

  const resolver = new ModelResolver(registry);
  const providerConfig = { ...config('key-a'), baseUrl: 'https://example.test/v1' };
  await resolver.list(providerConfig);
  await resolver.list({ ...providerConfig });

  assert.equal(calls, 1);
});

test('provider invalidation clears every credential-scoped cache entry for that provider', async () => {
  const registry = new ProviderRegistry();
  let calls = 0;
  registry.register({
    id: 'openai',
    displayName: 'OpenAI',
    listModels: async (providerConfig) => {
      calls += 1;
      return [{ id: `model-${providerConfig.apiKey}`, name: 'Model', providerId: 'openai', capabilities: ['text'] }];
    },
    send: async () => ({ content: '', model: 'unused', providerId: 'openai' }),
  });

  const resolver = new ModelResolver(registry);
  await resolver.list(config('key-a'));
  await resolver.list(config('key-b'));
  resolver.invalidate('openai');
  await resolver.list(config('key-a'));
  await resolver.list(config('key-b'));

  assert.equal(calls, 4);
});
