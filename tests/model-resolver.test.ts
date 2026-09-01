import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelResolver } from '../src/ai/model-resolver';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIModel, AIProviderConfig } from '../src/ai/types';

test('resolves legacy unconfigured sentinels through the shared model ranking', async () => {
  const models: AIModel[] = [
    { id: 'model-basic', name: 'Basic', providerId: 'openai', capabilities: ['text'] },
    { id: 'model-default', name: 'Default', providerId: 'openai', capabilities: ['text', 'streaming', 'tools'] },
  ];
  const registry = new ProviderRegistry();
  registry.register({
    id: 'openai',
    displayName: 'OpenAI',
    listModels: async () => models,
    send: async () => ({ content: '', model: 'model-default', providerId: 'openai' }),
  });
  const resolver = new ModelResolver(registry);
  const config: AIProviderConfig = { id: 'openai', displayName: 'OpenAI', apiKey: 'test', enabled: true };
  const available = await resolver.list(config);

  assert.deepEqual(resolver.find(available, 'unconfigured'), models[1]);
  assert.deepEqual(resolver.find(available, 'Unconfigured'), models[1]);
});

test('still rejects unknown configured model ids', () => {
  const registry = new ProviderRegistry();
  const resolver = new ModelResolver(registry);
  const models: AIModel[] = [{ id: 'model-default', name: 'Default', providerId: 'openai', capabilities: ['text'] }];

  assert.throws(() => resolver.find(models, 'missing-model'), /Modelo 'missing-model' não está disponível\./);
});
