import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderConfig, AIRequest, AIStreamEvent } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'stream-source-fixture',
  displayName: 'Stream Source Fixture',
  apiKey: '',
  enabled: true,
};

const request: AIRequest = {
  providerId: config.id,
  model: 'local-stream',
  intelligence: 'normal',
  toolsEnabled: false,
  messages: [
    {
      role: 'system',
      content: [
        'Contexto Web atual recuperado pelo Auto CodeZ.',
        'Consulta: current package docs',
        '',
        '[1] Package docs',
        'URL: https://docs.example/package#current',
        'Snippet: Documentação atual.',
      ].join('\n'),
    },
    { role: 'user', content: 'Use fontes atuais.' },
  ],
};

test('provider registry adds Auto CodeZ sources to streaming completion events', async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: config.id,
    displayName: config.displayName,
    requiresApiKey: false,
    async listModels() {
      return [{ id: 'local-stream', name: 'Local Stream', providerId: config.id, capabilities: ['text', 'streaming'] }];
    },
    async send() {
      return { content: 'fallback', model: 'local-stream', providerId: config.id };
    },
    async *stream(): AsyncIterable<AIStreamEvent> {
      yield { type: 'start' };
      yield { type: 'delta', text: 'Resposta' };
      yield {
        type: 'complete',
        response: {
          content: 'Resposta',
          model: 'local-stream',
          providerId: config.id,
          sources: [{ title: 'Provider release notes', url: 'https://provider.example/releases#latest', origin: 'provider-native' }],
        },
      };
    },
  });

  const events: AIStreamEvent[] = [];
  for await (const event of registry.get(config.id).stream!(config, request)) events.push(event);
  const complete = events.find((event) => event.type === 'complete');
  assert.deepEqual(complete?.response?.sources, [
    {
      title: 'Provider release notes',
      url: 'https://provider.example/releases',
      origin: 'provider-native',
    },
    {
      title: 'Package docs',
      url: 'https://docs.example/package',
      origin: 'autocodez-web',
      citation: 1,
      snippet: 'Documentação atual.',
    },
  ]);
});
