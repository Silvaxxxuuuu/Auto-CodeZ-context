import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { PermissionRuntime } from '../src/agent/permission-runtime';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import { mergeAISources, normalizeAISource } from '../src/ai/source-normalization';
import type { AIProviderConfig, AIRequest, ChatRecord } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'local-source-fixture',
  displayName: 'Local Source Fixture',
  apiKey: '',
  enabled: true,
};

function request(messages: AIRequest['messages']): AIRequest {
  return {
    providerId: config.id,
    model: 'local-model',
    messages,
    intelligence: 'normal',
    toolsEnabled: false,
  };
}

function registerFixture(registry: ProviderRegistry, responseSources = false): void {
  registry.register({
    id: config.id,
    displayName: config.displayName,
    requiresApiKey: false,
    async listModels() {
      return [{ id: 'local-model', name: 'Local Model', providerId: config.id, capabilities: ['text'] }];
    },
    async send(_config, input) {
      return {
        content: 'Resposta local.',
        model: input.model,
        providerId: config.id,
        ...(responseSources ? {
          sources: [{ title: 'Documentação nativa', url: 'https://provider.example/docs#latest', origin: 'provider-native' as const }],
        } : {}),
      };
    },
  });
}

test('source normalization keeps only bounded public HTTP(S) metadata and deduplicates URLs', () => {
  assert.equal(normalizeAISource({ title: 'Local', url: 'file:///tmp/secret', origin: 'autocodez-web' }), undefined);
  assert.equal(normalizeAISource({ title: 'Credencial', url: 'https://user:pass@example.com/docs', origin: 'autocodez-web' }), undefined);
  const sources = mergeAISources(
    [{ title: 'Docs', url: 'https://example.com/docs#one', origin: 'autocodez-web', citation: 1 }],
    [{ title: 'Documentação oficial completa', url: 'https://example.com/docs#two', origin: 'provider-native', snippet: 'Atualizada.' }],
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://example.com/docs');
  assert.equal(sources[0].title, 'Documentação oficial completa');
  assert.equal(sources[0].citation, 1);
  assert.equal(sources[0].snippet, 'Atualizada.');
});

test('every registered provider receives structured sources from Auto CodeZ grounding context', async () => {
  const registry = new ProviderRegistry();
  registerFixture(registry);
  const response = await registry.get(config.id).send(config, request([
    {
      role: 'system',
      content: [
        'Contexto Web atual recuperado pelo Auto CodeZ.',
        'Consulta: latest runtime docs',
        '',
        '[1] Runtime docs',
        'URL: https://docs.example/runtime',
        'Snippet: Versão atual documentada.',
      ].join('\n'),
    },
    { role: 'user', content: 'Use a documentação atual.' },
  ]));

  assert.deepEqual(response.sources, [{
    title: 'Runtime docs',
    url: 'https://docs.example/runtime',
    origin: 'autocodez-web',
    citation: 1,
    snippet: 'Versão atual documentada.',
  }]);
});

test('web tool results become structured sources before the next provider round', async () => {
  const registry = new ProviderRegistry();
  registerFixture(registry);
  const response = await registry.get(config.id).send(config, request([
    { role: 'user', content: 'Pesquise uma ferramenta atual.' },
    {
      role: 'tool',
      toolName: 'web_search',
      toolCallId: 'web-1',
      content: JSON.stringify({
        type: 'web_search_results',
        searchProvider: 'Fixture Search',
        retrievedAt: 123,
        sources: [
          { id: 1, title: 'Ferramenta oficial', url: 'https://tool.example/docs', snippet: 'API atual.' },
          { id: 2, title: 'Release notes', url: 'https://tool.example/releases' },
        ],
      }),
    },
  ]));

  assert.equal(response.sources?.length, 2);
  assert.deepEqual(response.sources?.map((source) => source.url), ['https://tool.example/docs', 'https://tool.example/releases']);
  assert.equal(response.sources?.[0].searchProvider, 'Fixture Search');
  assert.equal(response.sources?.[0].retrievedAt, 123);
});

test('local keyless provider sources survive AgentRuntime persistence into the assistant message', async () => {
  const registry = new ProviderRegistry();
  registerFixture(registry, true);
  const activity = new ActivityRuntime();
  const chatRuntime = new ChatRuntime(registry, undefined, undefined, activity);
  const tools = new ShadowAwareToolRuntime(new WorkspaceRuntime(async () => []), new PermissionRuntime(), activity);
  const agent = new AgentRuntime(chatRuntime, tools, activity);
  const chat: ChatRecord = {
    id: 'chat-local-sources',
    title: 'Local sources',
    providerId: config.id,
    model: 'local-model',
    intelligence: 'normal',
    permissionLevel: 'read-only',
    messages: [{ role: 'user', content: 'Explique este conceito estável.' }],
    createdAt: 1,
    updatedAt: 1,
  };

  const result = await agent.run(config, chat, undefined, 'read-only', 'run-local-sources');
  const final = result.messages.at(-1);
  assert.equal(final?.role, 'assistant');
  assert.deepEqual(final?.sources, [{
    title: 'Documentação nativa',
    url: 'https://provider.example/docs',
    origin: 'provider-native',
  }]);
  assert.deepEqual(result.response.sources, final?.sources);
});
