import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { McpGatewayBindingStore, type McpGatewayBridgeBinding } from '../src/mcp-gateway/binding-store';
import { McpStdioBridgeRuntime } from '../src/mcp-gateway/stdio-bridge-runtime';

function secureStorage(): SecureStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8'),
    decrypt: (value) => value.toString('utf8'),
  };
}

test('MCP gateway binding is encrypted at rest and rejects non-loopback endpoints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-mcp-binding-'));
  try {
    const storage = new LocalStorage(root, secureStorage());
    await storage.init();
    const store = new McpGatewayBindingStore(storage, () => 1234);
    const bearerToken = 'x'.repeat(48);
    const written = await store.write({ endpoint: 'http://127.0.0.1:49152/mcp', bearerToken, ownerPid: 42 });
    assert.equal(written.updatedAt, 1234);
    assert.equal((await store.read())?.bearerToken, bearerToken);

    const raw = await fs.readFile(path.join(root, 'mcp-gateway-binding.json'), 'utf8');
    assert.equal(raw.includes(bearerToken), false);
    await assert.rejects(() => store.write({ endpoint: 'https://example.com/mcp', bearerToken, ownerPid: 42 }), /Binding MCP local inválido/);

    await store.clear();
    assert.equal(await store.read(), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('MCP stdio bridge forwards authenticated JSON-RPC and preserves client identity', async () => {
  const binding: McpGatewayBridgeBinding = {
    endpoint: 'http://127.0.0.1:4000/mcp',
    bearerToken: 'b'.repeat(48),
    ownerPid: 1,
    updatedAt: 1,
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body)) as { id?: unknown; method?: string };
    if (body.method === 'server/discover') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2026-07-28' } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }), { status: 200 });
  }) as typeof fetch;

  let launches = 0;
  const bridge = new McpStdioBridgeRuntime(async () => binding, async () => { launches += 1; }, fetchImpl);
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => { stdout += chunk; });

  const running = bridge.run(input, output, 'codex');
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) + '\n');
  await running;

  assert.equal(launches, 0);
  assert.match(stdout, /"id":7/);
  const forwarded = requests.find((entry) => JSON.parse(String(entry.init?.body)).method === 'tools/list');
  assert.ok(forwarded);
  const headers = new Headers(forwarded.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${binding.bearerToken}`);
  assert.equal(headers.get('x-auto-codez-mcp-client'), 'codex');
});

test('MCP stdio bridge launches Auto CodeZ when no live binding exists', async () => {
  const binding: McpGatewayBridgeBinding = {
    endpoint: 'http://127.0.0.1:4001/mcp',
    bearerToken: 'c'.repeat(48),
    ownerPid: 2,
    updatedAt: 2,
  };
  let launched = false;
  let reads = 0;
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: unknown };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { status: 200 });
  }) as typeof fetch;
  const bridge = new McpStdioBridgeRuntime(
    async () => {
      reads += 1;
      return launched && reads > 1 ? binding : undefined;
    },
    async () => { launched = true; },
    fetchImpl,
    async () => undefined,
    1000,
  );

  const input = new PassThrough();
  const output = new PassThrough();
  const running = bridge.run(input, output, 'cursor');
  input.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await running;
  assert.equal(launched, true);
});

test('MCP stdio bridge emits parse errors without forwarding malformed lines', async () => {
  const binding: McpGatewayBridgeBinding = {
    endpoint: 'http://127.0.0.1:4002/mcp',
    bearerToken: 'd'.repeat(48),
    ownerPid: 3,
    updatedAt: 3,
  };
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: unknown };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { status: 200 });
  }) as typeof fetch;
  const bridge = new McpStdioBridgeRuntime(async () => binding, async () => undefined, fetchImpl);
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => { stdout += chunk; });

  const running = bridge.run(input, output, 'other');
  input.end('{broken-json\n');
  await running;
  assert.match(stdout, /-32700/);
});
