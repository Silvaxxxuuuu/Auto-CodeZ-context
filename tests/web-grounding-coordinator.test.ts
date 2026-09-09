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

test('freshness coordinator fails closed when current facts require search but no sources exist', async () => {
  const runtime = new WebRetrievalRuntime({ searchAdapter: { id: 'fixture', displayName: 'Fixture', async search() { return []; } } });
  const coordinator = new WebGroundingCoordinator({ runtime, now: () => 10, fetchLimit: 0 });
  await assert.rejects(() => coordinator.ground([user('Quais são as notícias mais recentes agora?')]), /não retornou fontes/);
});
