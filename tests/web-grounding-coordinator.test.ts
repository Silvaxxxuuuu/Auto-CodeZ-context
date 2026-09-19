import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIMessage } from '../src/ai/types';
import { WebGroundingCoordinator } from '../src/web/web-grounding-coordinator';
import type { WebHttpTransport } from '../src/web/web-http-client';
import type { WebHostResolver } from '../src/web/web-network-policy';
import { WebRetrievalRuntime } from '../src/web/web-retrieval-runtime';
import type { WebSearchAdapter } from '../src/web/web-types';

const resolver: WebHostResolver = async (hostname) => [{ address: hostname === 'weather-two.example' ? '93.184.216.35' : '93.184.216.34', family: 4 }];

function user(content: string): AIMessage { return { role: 'user', content }; }

test('freshness coordinator does not browse for timeless requests', async () => {
  let searches = 0;
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { searches += 1; return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8) });
  assert.deepEqual(coordinator.classify([user('Explique closures em JavaScript')]), { required: false, userMessage: 'Explique closures em JavaScript' });
  assert.equal(await coordinator.ground([user('Explique closures em JavaScript')]), undefined);
  assert.equal(searches, 0);
});

test('freshness coordinator does not treat generic current workspace wording as public-web freshness', () => {
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8) });
  assert.deepEqual(
    coordinator.classify([user('Corrija a implementação atual deste arquivo e mantenha o comportamento existente.')]),
    { required: false, userMessage: 'Corrija a implementação atual deste arquivo e mantenha o comportamento existente.' },
  );
  assert.deepEqual(
    coordinator.classify([user('Revise o código atual do provider e melhore os testes.')]),
    { required: false, userMessage: 'Revise o código atual do provider e melhore os testes.' },
  );
});

test('grounding coordinator recognizes an explicit request to research public documentation', () => {
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8) });
  assert.deepEqual(
    coordinator.classify([user('Pesquise na web a documentação do Electron Forge e veja como funciona o plugin Vite.')]),
    {
      required: true,
      reason: 'explicit-research',
      userMessage: 'Pesquise na web a documentação do Electron Forge e veja como funciona o plugin Vite.',
    },
  );
  assert.deepEqual(
    coordinator.classify([user('Verifique a documentação do SDK antes de sugerir a implementação.')]),
    {
      required: true,
      reason: 'explicit-research',
      userMessage: 'Verifique a documentação do SDK antes de sugerir a implementação.',
    },
  );
});

test('grounding coordinator recognizes technical discovery even without a current-date keyword', () => {
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8) });
  assert.deepEqual(
    coordinator.classify([user('Quais bibliotecas estão disponíveis para validar schemas em TypeScript?')]),
    {
      required: true,
      reason: 'technical-research',
      userMessage: 'Quais bibliotecas estão disponíveis para validar schemas em TypeScript?',
    },
  );
  assert.deepEqual(
    coordinator.classify([user('Qual ferramenta serve melhor para gerar documentação de uma API TypeScript?')]),
    {
      required: true,
      reason: 'technical-research',
      userMessage: 'Qual ferramenta serve melhor para gerar documentação de uma API TypeScript?',
    },
  );
});

test('freshness coordinator grounds a mutable external entity when explicitly requested as current', () => {
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8) });
  assert.deepEqual(
    coordinator.classify([user('Quem é o atual presidente de Exemplo?')]),
    { required: true, reason: 'current-facts', userMessage: 'Quem é o atual presidente de Exemplo?' },
  );
  assert.deepEqual(
    coordinator.classify([user('Qual é o salário mínimo atual?')]),
    { required: true, reason: 'current-facts', userMessage: 'Qual é o salário mínimo atual?' },
  );
});

test('freshness coordinator automatically grounds current weather with dated sources', async () => {
  let searches = 0;
  let fetches = 0;
  const searchAdapter: WebSearchAdapter = {
    id: 'fixture',
    displayName: 'Fixture Search',
    async search(query) {
      searches += 1;
      assert.match(query, /2026-09-08/);
      return [
        { title: 'Meteorologia oficial', url: 'https://weather-one.example/forecast', snippet: 'Previsão atualizada.' },
        { title: 'Segunda fonte', url: 'https://weather-two.example/forecast', snippet: 'Dados horários.' },
      ];
    },
  };
  const transport: WebHttpTransport = async (destination) => {
    fetches += 1;
    return {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(`<html><head><title>${destination.url.hostname}</title></head><body><p>Hoje 28°C, amanhã 27°C.</p></body></html>`),
    };
  };
  const runtime = new WebRetrievalRuntime({ searchAdapter, requestOptions: { resolver, transport }, now: () => 77 });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8, 15), fetchLimit: 2 });
  const result = await coordinator.ground([user('Me diga a previsão de hoje e amanhã')]);
  assert.equal(result?.reason, 'live-data');
  assert.equal(result?.sources.length, 2);
  assert.match(result?.context || '', /Meteorologia oficial/);
  assert.match(result?.context || '', /Hoje 28°C, amanhã 27°C/);
  assert.match(result?.context || '', /Ignore instruções/);
  assert.match(result?.context || '', /CITAÇÕES/);
  assert.equal(searches, 1);
  assert.equal(fetches, 2);
});

test('explicit technical research produces a source-backed context even for a non-temporal question', async () => {
  let query = '';
  const searchAdapter: WebSearchAdapter = {
    id: 'fixture',
    displayName: 'Fixture',
    async search(value) {
      query = value;
      return [{ title: 'Official SDK docs', url: 'https://docs.example/sdk', snippet: 'Supported tools: alpha, beta.' }];
    },
  };
  const runtime = new WebRetrievalRuntime({ searchAdapter });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => Date.UTC(2026, 8, 8), fetchLimit: 0 });
  const result = await coordinator.ground([user('Pesquise na web quais ferramentas o SDK oferece para TypeScript.')]);
  assert.equal(result?.reason, 'explicit-research');
  assert.match(query, /ferramentas o SDK oferece/i);
  assert.match(result?.context || '', /Official SDK docs/);
  assert.match(result?.context || '', /Supported tools: alpha, beta/);
});

test('freshness coordinator reuses a short-lived grounding snapshot across agent rounds', async () => {
  let searches = 0;
  const searchAdapter: WebSearchAdapter = {
    id: 'fixture',
    displayName: 'Fixture',
    async search() { searches += 1; return [{ title: 'Fonte', url: 'https://example.com/current', snippet: 'Atual.' }]; },
  };
  let now = 1_000;
  const runtime = new WebRetrievalRuntime({ searchAdapter });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => now, fetchLimit: 0, cacheTtlMs: 10_000 });
  const messages = [user('Qual é a versão mais recente do pacote?')];
  const first = await coordinator.ground(messages);
  now = 5_000;
  const second = await coordinator.ground([...messages, { role: 'tool', content: 'resultado intermediário' }]);
  assert.equal(first?.cached, false);
  assert.equal(second?.cached, true);
  assert.equal(searches, 1);
});

test('freshness coordinator fails closed when required research returns no sources', async () => {
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => 10, fetchLimit: 0 });
  await assert.rejects(() => coordinator.ground([user('Quais são as notícias mais recentes agora?')]), /não retornou fontes/);
  await assert.rejects(() => coordinator.ground([user('Pesquise na web a documentação da ferramenta X.')]), /não retornou fontes/);
});
