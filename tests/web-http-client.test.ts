import assert from 'node:assert/strict';
import test from 'node:test';
import { requestPublicText, type WebHttpTransport } from '../src/web/web-http-client';
import type { WebHostResolver } from '../src/web/web-network-policy';

const resolver: WebHostResolver = async (hostname) => [{ address: hostname === 'second.example' ? '93.184.216.35' : '93.184.216.34', family: 4 }];

test('public HTTP client revalidates every redirect before transport', async () => {
  let calls = 0;
  const transport: WebHttpTransport = async () => {
    calls += 1;
    return {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
      body: new Uint8Array(),
    };
  };
  await assert.rejects(
    () => requestPublicText('https://example.com/start', { resolver, transport }),
    /rede local ou reservada/,
  );
  assert.equal(calls, 1);
});

test('public HTTP client follows validated public redirects and returns text', async () => {
  const destinations: string[] = [];
  const transport: WebHttpTransport = async (destination) => {
    destinations.push(destination.url.toString());
    if (destinations.length === 1) {
      return { status: 302, headers: { location: 'https://second.example/final' }, body: new Uint8Array() };
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('conteúdo atual'),
    };
  };
  const response = await requestPublicText('https://example.com/start', { resolver, transport });
  assert.deepEqual(destinations, ['https://example.com/start', 'https://second.example/final']);
  assert.equal(response.url, 'https://second.example/final');
  assert.equal(response.text, 'conteúdo atual');
});

test('public HTTP client blocks binary content types', async () => {
  const transport: WebHttpTransport = async () => ({
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from([1, 2, 3]),
  });
  await assert.rejects(
    () => requestPublicText('https://example.com/file', { resolver, transport }),
    /Tipo de conteúdo web não permitido/,
  );
});

test('public HTTP client limits redirect chains', async () => {
  const transport: WebHttpTransport = async (destination) => ({
    status: 302,
    headers: { location: `${destination.url.origin}/again` },
    body: new Uint8Array(),
  });
  await assert.rejects(
    () => requestPublicText('https://example.com/start', { resolver, transport, maxRedirects: 1 }),
    /limite de redirects/,
  );
});

test('public HTTP client rejects non-success responses', async () => {
  const transport: WebHttpTransport = async () => ({ status: 503, headers: { 'content-type': 'text/plain' }, body: Buffer.from('down') });
  await assert.rejects(
    () => requestPublicText('https://example.com/', { resolver, transport }),
    /HTTP 503/,
  );
});
