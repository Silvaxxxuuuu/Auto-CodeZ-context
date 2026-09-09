import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { PermissionRuntime } from '../src/agent/permission-runtime';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { WebRetrievalRuntime } from '../src/web/web-retrieval-runtime';
import type { WebHttpTransport } from '../src/web/web-http-client';
import type { WebHostResolver } from '../src/web/web-network-policy';
import type { WebSearchAdapter } from '../src/web/web-types';

function createTools(searchAdapter: WebSearchAdapter, transport?: WebHttpTransport) {
  const activity = new ActivityRuntime();
  const events: string[] = [];
  activity.subscribe((event) => events.push(`${event.status}:${event.message}`));
  const tools = new ShadowAwareToolRuntime(new WorkspaceRuntime(async () => []), new PermissionRuntime(), activity);
  const resolver: WebHostResolver = async () => [{ address: '93.184.216.34', family: 4 }];
  tools.configureWebRetrieval(new WebRetrievalRuntime({ searchAdapter, requestOptions: { resolver, ...(transport ? { transport } : {}) }, now: () => 42 }));
  return { tools, events };
}

test('shared agent tool catalog exposes provider-independent web tools', () => {
  const { tools } = createTools({ id: 'fixture', displayName: 'Fixture', async search() { return []; } });
  const names = tools.listDefinitions().map((definition) => definition.name);
  assert.equal(names.includes('web_search'), true);
  assert.equal(names.includes('web_fetch'), true);
});

test('web_search runs in read-only mode and emits real activity', async () => {
  const adapter: WebSearchAdapter = {
    id: 'fixture',
    displayName: 'Fixture Search',
    async search(query) {
      assert.equal(query, 'previsão hoje amanhã');
      return [{ title: 'Meteorologia', url: 'https://weather.example/current', snippet: 'Dados atualizados.' }];
    },
  };
  const { tools, events } = createTools(adapter);
  const result = await tools.execute('chat-1', 'project-not-needed', 'read-only', {
    id: 'web-1',
    name: 'web_search',
    input: { query: 'previsão hoje amanhã', limit: 4 },
  }, 'run-1');
  assert.equal(result.ok, true);
  const output = JSON.parse(result.output || '{}') as { sources?: Array<{ url: string }>; untrustedExternalData?: boolean };
  assert.equal(output.sources?.[0]?.url, 'https://weather.example/current');
  assert.equal(output.untrustedExternalData, true);
  assert.equal(events.some((event) => event.startsWith('running:Pesquisando na web:')), true);
  assert.equal(events.some((event) => event.startsWith('success:Busca web concluída:')), true);
});

test('web_search blocks secret-like outbound queries before adapter execution', async () => {
  let calls = 0;
  const { tools } = createTools({
    id: 'fixture',
    displayName: 'Fixture',
    async search() { calls += 1; return []; },
  });
  const result = await tools.execute('chat-1', 'project-not-needed', 'safe', {
    id: 'web-secret',
    name: 'web_search',
    input: { query: 'api_key=super-secret-token-value-123456789' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /credencial ou segredo/);
  assert.equal(calls, 0);
});

test('web_fetch returns bounded untrusted source content and activity', async () => {
  const transport: WebHttpTransport = async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<html><head><title>Docs atuais</title></head><body><p>Versão 9.1 publicada hoje.</p></body></html>'),
  });
  const { tools, events } = createTools({ id: 'fixture', displayName: 'Fixture', async search() { return []; } }, transport);
  const result = await tools.execute('chat-2', 'project-not-needed', 'read-only', {
    id: 'fetch-1',
    name: 'web_fetch',
    input: { url: 'https://docs.example/latest' },
  }, 'run-2');
  assert.equal(result.ok, true);
  const output = JSON.parse(result.output || '{}') as { source?: { title?: string; retrievedAt?: number }; content?: string; untrustedExternalData?: boolean };
  assert.equal(output.source?.title, 'Docs atuais');
  assert.equal(output.source?.retrievedAt, 42);
  assert.match(output.content || '', /Versão 9\.1/);
  assert.equal(output.untrustedExternalData, true);
  assert.equal(events.some((event) => event.includes('Abrindo fonte web: docs.example')), true);
  assert.equal(events.some((event) => event.includes('Fonte web carregada: Docs atuais')), true);
});
