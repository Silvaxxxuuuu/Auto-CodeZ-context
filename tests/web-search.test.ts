import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDuckGoHtmlSearchAdapter, parseDuckDuckGoHtml, parseDuckDuckGoLite } from '../src/web/search/duckduckgo-html';
import { assertSafeWebUrlText, normalizeWebSearchQuery } from '../src/web/web-query-policy';
import type { WebHttpTransport } from '../src/web/web-http-client';

const fixture = `
<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fweather%3Fday%3Dtoday">Previsão &amp; clima</a>
  <a class="result__snippet">Temperaturas atualizadas para hoje e amanhã.</a>
</div>
<div class="result">
  <a class="result__a" href="https://second.example/news">Notícias <strong>atuais</strong></a>
  <div class="result__snippet">Atualizado há poucos minutos.</div>
</div>
</body></html>`;

const liteFixture = `
<html><body><table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example%2Flatest">Documentação &amp; atual</a></td></tr>
<tr><td class="result-snippet">Referência atualizada da API.</td></tr>
<tr><td><a class="result-link" href="https://release.example/v2">Release <b>2</b></a></td></tr>
<tr><td class="result-snippet">Notas da versão atual.</td></tr>
</table></body></html>`;

test('DuckDuckGo HTML parser returns normalized direct sources and snippets', () => {
  const results = parseDuckDuckGoHtml(fixture, 5);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: 'Previsão & clima',
    url: 'https://example.com/weather?day=today',
    snippet: 'Temperaturas atualizadas para hoje e amanhã.',
  });
  assert.deepEqual(results[1], {
    title: 'Notícias atuais',
    url: 'https://second.example/news',
    snippet: 'Atualizado há poucos minutos.',
  });
});

test('DuckDuckGo Lite parser provides a second bounded search route', () => {
  const results = parseDuckDuckGoLite(liteFixture, 5);
  assert.deepEqual(results, [
    { title: 'Documentação & atual', url: 'https://docs.example/latest', snippet: 'Referência atualizada da API.' },
    { title: 'Release 2', url: 'https://release.example/v2', snippet: 'Notas da versão atual.' },
  ]);
});

test('DuckDuckGo adapter falls back to Lite when the primary search route fails', async () => {
  const requestedHosts: string[] = [];
  const transport: WebHttpTransport = async (destination) => {
    requestedHosts.push(destination.url.hostname);
    if (destination.url.hostname === 'html.duckduckgo.com') throw new Error('primary unavailable');
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: new TextEncoder().encode(liteFixture),
    };
  };
  const adapter = new DuckDuckGoHtmlSearchAdapter({
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport,
  });
  const results = await adapter.search('current API documentation', { limit: 2 });
  assert.deepEqual(requestedHosts, ['html.duckduckgo.com', 'lite.duckduckgo.com']);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://docs.example/latest');
});

test('web query policy normalizes ordinary public research searches', () => {
  assert.equal(normalizeWebSearchQuery('  previsão   do tempo hoje   amanhã  '), 'previsão do tempo hoje amanhã');
  assert.equal(normalizeWebSearchQuery('Electron Forge latest Vite plugin documentation'), 'Electron Forge latest Vite plugin documentation');
  assert.equal(normalizeWebSearchQuery('TypeScript schema validation libraries available 2026'), 'TypeScript schema validation libraries available 2026');
});

test('web query policy blocks likely secrets and raw code payloads', () => {
  assert.throws(() => normalizeWebSearchQuery('api_key=super-secret-token-value-123456789'), /credencial ou segredo/);
  assert.throws(() => normalizeWebSearchQuery('procure isto ```const secret = 1```'), /código bruto/);
  assert.throws(() => normalizeWebSearchQuery('pesquise por const privateState = loadProjectState()'), /código bruto/);
  assert.throws(() => normalizeWebSearchQuery('descubra o erro em function internalBuild(input) { return input; }'), /código bruto/);
  assert.throws(() => normalizeWebSearchQuery('pesquise {"privateProject":"alpha","token":"value"}'), /código bruto/);
  assert.throws(() => assertSafeWebUrlText('https://example.com/?token=ghp_abcdefghijklmnopqrstuvwxyz123456'), /credencial ou segredo/);
});

test('web query policy blocks local filesystem paths instead of leaking them to search', () => {
  assert.throws(() => normalizeWebSearchQuery('pesquise erro C:\\Users\\Gabriel\\Desktop\\Projeto\\src\\main.ts Electron'), /caminho local/);
  assert.throws(() => normalizeWebSearchQuery('search this error from /home/user/private-project/src/main.ts'), /caminho local/);
  assert.throws(() => normalizeWebSearchQuery('look up file:///Users/example/private/index.ts'), /caminho local/);
});

test('web query policy enforces bounded outbound input', () => {
  assert.throws(() => normalizeWebSearchQuery('x'.repeat(501)), /500 caracteres/);
  assert.throws(() => assertSafeWebUrlText(`https://example.com/${'x'.repeat(5000)}`), /tamanho permitido/);
});
