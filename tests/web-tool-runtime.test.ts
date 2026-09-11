import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { PermissionRuntime } from '../src/agent/permission-runtime';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ExecutionChangeBudgetRuntime } from '../src/execution-change-budget';
import { ExecutionPlanner } from '../src/execution-planner';
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

test('shared agent tool catalog exposes provider-independent proactive web tools', () => {
  const { tools } = createTools({ id: 'fixture', displayName: 'Fixture', async search() { return []; } });
  const definitions = tools.listDefinitions();
  const search = definitions.find((definition) => definition.name === 'web_search');
  const fetch = definitions.find((definition) => definition.name === 'web_fetch');
  assert.ok(search);
  assert.ok(fetch);
  assert.match(search.description, /documentation, libraries, frameworks, APIs, package versions, tools/i);
  assert.match(search.description, /not limited to news or weather/i);
  assert.equal(search.requiresWriteAccess, false);
  assert.equal(search.requiresApproval, false);
});

test('web_search runs in read-only mode and emits real activity', async () => {
  const adapter: WebSearchAdapter = {
    id: 'fixture',
    displayName: 'Fixture Search',
    async search(query) {
      assert.equal(query, 'latest Electron Forge Vite plugin documentation');
      return [{ title: 'Electron Forge docs', url: 'https://docs.example/forge', snippet: 'Current Vite plugin documentation.' }];
    },
  };
  const { tools, events } = createTools(adapter);
  const result = await tools.execute('chat-1', 'project-not-needed', 'read-only', {
    id: 'web-1',
    name: 'web_search',
    input: { query: 'latest Electron Forge Vite plugin documentation', limit: 4 },
  }, 'run-1');
  assert.equal(result.ok, true);
  const output = JSON.parse(result.output || '{}') as {
    type?: string;
    query?: string;
    searchProvider?: string;
    sourceCount?: number;
    security?: string;
    sources?: Array<{ id: number; url: string }>;
  };
  assert.equal(output.type, 'web_search_results');
  assert.equal(output.query, 'latest Electron Forge Vite plugin documentation');
  assert.equal(output.searchProvider, 'Fixture Search');
  assert.equal(output.sourceCount, 1);
  assert.equal(output.sources?.[0]?.id, 1);
  assert.equal(output.sources?.[0]?.url, 'https://docs.example/forge');
  assert.match(output.security || '', /untrusted data/i);
  assert.equal(events.some((event) => event.startsWith('running:Pesquisando na web:')), true);
  assert.equal(events.some((event) => event.startsWith('success:Pesquisa Web concluída:')), true);
});

test('web_search rejects private outbound content before network execution or activity logging', async () => {
  let calls = 0;
  const { tools, events } = createTools({
    id: 'fixture',
    displayName: 'Fixture',
    async search() { calls += 1; return []; },
  });
  const secret = 'super-secret-token-value-123456789';
  const result = await tools.execute('chat-1', 'project-not-needed', 'safe', {
    id: 'web-secret',
    name: 'web_search',
    input: { query: `api_key=${secret}` },
  });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /credencial ou segredo/);
  assert.equal(calls, 0);
  assert.equal(events.some((event) => event.includes(secret)), false);
  assert.equal(events.some((event) => event.startsWith('running:Pesquisando na web:')), false);

  const localPath = 'C:\\Users\\Example\\Desktop\\PrivateProject\\src\\main.ts';
  const pathResult = await tools.execute('chat-1', 'project-not-needed', 'safe', {
    id: 'web-path',
    name: 'web_search',
    input: { query: `pesquise o erro de ${localPath}` },
  });
  assert.equal(pathResult.ok, false);
  assert.match(pathResult.error || '', /caminho local/);
  assert.equal(calls, 0);
  assert.equal(events.some((event) => event.includes('PrivateProject')), false);
});

test('web_fetch rejects credential-bearing URLs before network execution or activity logging', async () => {
  let transportCalls = 0;
  const transport: WebHttpTransport = async () => {
    transportCalls += 1;
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('unexpected') };
  };
  const { tools, events } = createTools({ id: 'fixture', displayName: 'Fixture', async search() { return []; } }, transport);
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  const result = await tools.execute('chat-private-url', 'project-not-needed', 'read-only', {
    id: 'fetch-private-url',
    name: 'web_fetch',
    input: { url: `https://docs.example/private?token=${token}` },
  });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /credencial ou segredo/);
  assert.equal(transportCalls, 0);
  assert.equal(events.some((event) => event.includes(token)), false);
  assert.equal(events.some((event) => event.startsWith('running:Abrindo fonte Web:')), false);
});

test('web_fetch returns bounded untrusted source content and activity', async () => {
  const largeText = `Versão 9.1 publicada hoje. ${'A'.repeat(30_000)}`;
  const transport: WebHttpTransport = async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from(`<html><head><title>Docs atuais</title></head><body><p>${largeText}</p></body></html>`),
  });
  const { tools, events } = createTools({ id: 'fixture', displayName: 'Fixture', async search() { return []; } }, transport);
  const result = await tools.execute('chat-2', 'project-not-needed', 'read-only', {
    id: 'fetch-1',
    name: 'web_fetch',
    input: { url: 'https://docs.example/latest' },
  }, 'run-2');
  assert.equal(result.ok, true);
  const output = JSON.parse(result.output || '{}') as {
    type?: string;
    source?: { title?: string; retrievedAt?: number; url?: string };
    text?: string;
    truncated?: boolean;
    security?: string;
  };
  assert.equal(output.type, 'web_document');
  assert.equal(output.source?.title, 'Docs atuais');
  assert.equal(output.source?.retrievedAt, 42);
  assert.equal(output.source?.url, 'https://docs.example/latest');
  assert.match(output.text || '', /Versão 9\.1/);
  assert.equal(output.text?.length, 24_000);
  assert.equal(output.truncated, true);
  assert.match(output.security || '', /untrusted data/i);
  assert.equal(events.some((event) => event.includes('Abrindo fonte Web: https://docs.example/latest')), true);
  assert.equal(events.some((event) => event.includes('Fonte Web carregada: Docs atuais')), true);
});

test('successful proactive web research counts toward Change Budget and becomes plan evidence', async () => {
  const { tools } = createTools({
    id: 'fixture',
    displayName: 'Fixture',
    async search() {
      return [{ title: 'Official package docs', url: 'https://docs.example/package', snippet: 'Supported tools and APIs.' }];
    },
  });
  const planner = new ExecutionPlanner({ now: () => 100, createId: (() => {
    let id = 0;
    return () => `plan-id-${++id}`;
  })() });
  const budget = new ExecutionChangeBudgetRuntime(() => 100);
  tools.configureExecutionPlanner(planner);
  tools.configureExecutionChangeBudget(budget);
  budget.configure('chat-plan', 'run-plan', { maxToolCalls: 1 });
  const plan = planner.create('chat-plan', 'run-plan', 'Escolher uma ferramenta atual para o projeto.', ['Pesquisar documentação e ferramentas disponíveis']);
  planner.startStep('chat-plan', 'run-plan', plan.steps[0].id);

  const result = await tools.execute('chat-plan', 'project-not-needed', 'read-only', {
    id: 'web-research',
    name: 'web_search',
    input: { query: 'official package documentation supported tools APIs latest' },
  }, 'run-plan');

  assert.equal(result.ok, true);
  assert.equal(budget.getUsage('chat-plan', 'run-plan').toolCalls, 1);
  const updated = planner.get('chat-plan', 'run-plan');
  assert.equal(updated?.steps[0].evidence.length, 1);
  assert.equal(updated?.steps[0].evidence[0].type, 'tool');
  assert.equal(updated?.steps[0].evidence[0].summary, 'web_search concluído');
  assert.match(updated?.steps[0].evidence[0].reference || '', /official package documentation/);

  const blocked = await tools.execute('chat-plan', 'project-not-needed', 'read-only', {
    id: 'web-research-2',
    name: 'web_search',
    input: { query: 'another current package query' },
  }, 'run-plan');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error || '', /Change Budget excedido/);
});
