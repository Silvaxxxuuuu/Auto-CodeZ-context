import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelResolver } from '../src/ai/model-resolver';
import { ProviderRegistry } from '../src/ai/provider-registry';
import { AzureOpenAIAdapter } from '../src/ai/providers/azure-openai';
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

test('configured model resolution does not wait for slow discovery on the chat critical path', async () => {
  const registry = new ProviderRegistry();
  let releaseDiscovery: (() => void) | undefined;
  registry.register({
    id: 'slow-provider',
    displayName: 'Slow Provider',
    fallbackCapabilities: ['text', 'streaming', 'tools'],
    listModels: async () => {
      await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
      return [{ id: 'saved-model', name: 'Saved Model', providerId: 'slow-provider', capabilities: ['text', 'streaming', 'tools'] }];
    },
    send: async () => ({ content: '', model: 'saved-model', providerId: 'slow-provider' }),
  });
  const resolver = new ModelResolver(registry);
  const config: AIProviderConfig = { id: 'slow-provider', displayName: 'Slow Provider', apiKey: 'key', enabled: true };
  const startedAt = Date.now();

  const resolved = await resolver.resolveForRequest(config, 'saved-model', 20);
  const elapsed = Date.now() - startedAt;

  assert.equal(resolved.id, 'saved-model');
  assert.ok(elapsed < 200, `configured model resolution took ${elapsed}ms`);
  releaseDiscovery?.();
});

test('configured model resolution reuses one in-flight discovery request', async () => {
  const registry = new ProviderRegistry();
  let calls = 0;
  let releaseDiscovery: (() => void) | undefined;
  registry.register({
    id: 'dedup-provider',
    displayName: 'Dedup Provider',
    fallbackCapabilities: ['text', 'streaming'],
    listModels: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { releaseDiscovery = resolve; });
      return [{ id: 'saved-model', name: 'Saved Model', providerId: 'dedup-provider', capabilities: ['text', 'streaming'] }];
    },
    send: async () => ({ content: '', model: 'saved-model', providerId: 'dedup-provider' }),
  });
  const resolver = new ModelResolver(registry);
  const config: AIProviderConfig = { id: 'dedup-provider', displayName: 'Dedup Provider', apiKey: 'key', enabled: true };

  const first = resolver.resolveForRequest(config, 'saved-model', 5);
  const second = resolver.resolveForRequest(config, 'saved-model', 5);
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  releaseDiscovery?.();
});


test('configured model fallback can infer vision from saved model id without waiting for discovery', async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'smart-provider',
    displayName: 'Smart Provider',
    fallbackCapabilitiesForModel: (modelId) => modelId === 'vision-model' ? ['text','streaming','vision'] : ['text','streaming'],
    listModels: async () => await new Promise<AIModel[]>(() => {}),
    send: async () => ({ content: '', model: 'vision-model', providerId: 'smart-provider' }),
  });
  const resolver = new ModelResolver(registry);
  const config: AIProviderConfig = { id: 'smart-provider', displayName: 'Smart Provider', apiKey: 'key', enabled: true };
  const resolved = await resolver.resolveForRequest(config, 'vision-model', 5);
  assert.equal(resolved.capabilities.includes('vision'), true);
});

test('Azure Foundry fallback keeps vision for GPT vision model ids but not Kimi', () => {
  const adapter = new AzureOpenAIAdapter();
  assert.equal(adapter.fallbackCapabilitiesForModel('gpt-5.6-luna').includes('vision'), true);
  assert.equal(adapter.fallbackCapabilitiesForModel('gpt-4o').includes('vision'), true);
  assert.equal(adapter.fallbackCapabilitiesForModel('Kimi-K2.6').includes('vision'), false);
});

test('attachment picker separates Images from arbitrary Files and bounds local visual fallback', async () => {
  const fs = await import('node:fs/promises');
  const renderer = await fs.readFile('src/renderer.ts', 'utf8');
  const main = await fs.readFile('src/main.ts', 'utf8');
  const context = await fs.readFile('src/ai/attachment-context.ts', 'utf8');
  const indexer = await fs.readFile('src/ai/attachment-indexer.ts', 'utf8');

  assert.match(renderer, /id="attachment-menu"/);
  assert.match(renderer, /data-attachment-option="image"/);
  assert.match(renderer, /data-attachment-option="file"/);
  assert.match(main, /Imagens e arquivos gráficos/);
  for (const extension of ['heic', 'tiff', 'psd', 'ai', 'eps', 'pdf', 'indd', 'cdr', 'exr', 'dds']) {
    assert.match(main, new RegExp("'" + extension + "'"));
  }
  assert.match(main, /name: 'Todos os arquivos', extensions: \['\*'\]/);
  assert.match(context, /\[Imagem anexada ·/);
  assert.match(indexer, /max_tokens: 384/);
  assert.match(indexer, /const serverReady = this\.ensureServer/);
});
