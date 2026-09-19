import assert from 'node:assert/strict';
import test from 'node:test';
import { WebRetrievalRuntime } from '../src/web/web-retrieval-runtime';
import type { WebHttpTransport } from '../src/web/web-http-client';
import type { WebHostResolver } from '../src/web/web-network-policy';
import type { WebSearchAdapter } from '../src/web/web-types';

const resolver: WebHostResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('web retrieval runtime remains independent from the selected AI provider', async () => {
  let observedQuery = '';
  const searchAdapter: WebSearchAdapter = {
    id: 'fixture-search',
    displayName: 'Fixture Search',
    async search(query, options) {
      observedQuery = query;
      assert.equal(options?.limit, 3);
      return [{ title: 'Fonte atual', url: 'https://example.com/current', snippet: 'Atualizado hoje.' }];
    },
  };
  const runtime = new WebRetrievalRuntime({ searchAdapter });
  const results = await runtime.search('  informação   atual  ', { limit: 3 });
  assert.equal(observedQuery, 'informação atual');
  assert.equal(results[0]?.url, 'https://example.com/current');
});

test('web retrieval runtime extracts bounded readable text with source metadata', async () => {
  const transport: WebHttpTransport = async () => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: Buffer.from('<html><head><title>Clima agora</title><style>.x{}</style></head><body><h1>Previsão</h1><script>ignore()</script><p>Hoje: 28°C.</p><p>Amanhã: 27°C.</p></body></html>'),
  });
  const runtime = new WebRetrievalRuntime({
    requestOptions: { resolver, transport },
    now: () => 123456,
    searchAdapter: { id: 'unused', displayName: 'Unused', async search() { return []; } },
  });
  const result = await runtime.fetch('https://example.com/weather');
  assert.equal(result.url, 'https://example.com/weather');
  assert.equal(result.title, 'Clima agora');
  assert.match(result.text, /Previsão/);
  assert.match(result.text, /Hoje: 28°C/);
  assert.doesNotMatch(result.text, /ignore\(\)/);
  assert.equal(result.retrievedAt, 123456);
});

test('web retrieval runtime applies URL secret checks before network access', async () => {
  let called = false;
  const transport: WebHttpTransport = async () => {
    called = true;
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') };
  };
  const runtime = new WebRetrievalRuntime({
    requestOptions: { resolver, transport },
    searchAdapter: { id: 'unused', displayName: 'Unused', async search() { return []; } },
  });
  await assert.rejects(() => runtime.fetch('https://example.com/?api_key=super-secret-token-value-123456789'), /credencial ou segredo/);
  assert.equal(called, false);
});
