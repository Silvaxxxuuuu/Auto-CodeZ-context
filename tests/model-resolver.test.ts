import { describe, expect, it, vi } from 'vitest';
import { ModelResolver } from '../src/ai/model-resolver';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIModel, AIProviderConfig } from '../src/ai/types';

describe('ModelResolver', () => {
  it('resolves the first available model for legacy unconfigured sentinels', async () => {
    const models: AIModel[] = [{ id: 'model-default', name: 'Default', providerId: 'openai', capabilities: ['text'] }];
    const registry = new ProviderRegistry();
    registry.register({
      id: 'openai',
      displayName: 'OpenAI',
      listModels: vi.fn(async () => models),
      send: vi.fn(),
    });
    const resolver = new ModelResolver(registry);
    const config: AIProviderConfig = { id: 'openai', displayName: 'OpenAI', apiKey: 'test', enabled: true };
    const available = await resolver.list(config);

    expect(resolver.find(available, 'unconfigured')).toEqual(models[0]);
    expect(resolver.find(available, 'Unconfigured')).toEqual(models[0]);
  });

  it('still rejects unknown configured model ids', async () => {
    const registry = new ProviderRegistry();
    const resolver = new ModelResolver(registry);
    const models: AIModel[] = [{ id: 'model-default', name: 'Default', providerId: 'openai', capabilities: ['text'] }];

    expect(() => resolver.find(models, 'missing-model')).toThrow("Modelo 'missing-model' não está disponível.");
  });
});
