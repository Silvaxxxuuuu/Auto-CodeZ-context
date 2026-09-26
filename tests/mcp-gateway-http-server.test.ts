import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalLedger } from '../src/operational-ledger';
import { OperationalLedgerRetrieval } from '../src/operational-ledger-retrieval';
import type { AgentRuntime } from '../src/agent/agent-runtime';
import { McpGatewayExecutionRuntime } from '../src/mcp-gateway/execution-runtime';
import { McpGatewayProtocol } from '../src/mcp-gateway/protocol';
import { PluginToolCatalog } from '../src/plugins/plugin-tool-catalog';
import { McpGatewayHttpServer } from '../src/mcp-gateway/http-server';

function gateway() {
  const ledger = new OperationalLedger();
  ledger.record({
    actor: 'runtime',
    category: 'execution',
    state: 'success',
    summary: 'Execução concluída.',
    chatId: 'chat-a',
    runId: 'run-a',
    timestamp: 1000,
  });
  const protocol = new McpGatewayProtocol(new OperationalLedgerRetrieval(ledger));
  return new McpGatewayHttpServer(protocol);
}

function gatewayWithPluginTools() {
  const ledger = new OperationalLedger();
  const catalog = new PluginToolCatalog();
  catalog.register('test.plugin', [
    {
      id: 'inspect',
      description: 'Inspect test state.',
      risk: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      id: 'mutate',
      description: 'Mutate test state.',
      risk: 'write',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]);
  const execution = new McpGatewayExecutionRuntime({} as AgentRuntime, catalog);
  const protocol = new McpGatewayProtocol(new OperationalLedgerRetrieval(ledger), execution);
  return new McpGatewayHttpServer(protocol);
}

async function post(endpoint: string, token: string | undefined, body: unknown, headers: Record<string, string> = {}) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('MCP Gateway HTTP server binds only to loopback and requires bearer authentication', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'a'.repeat(48) });
  try {
    assert.equal(info.host, '127.0.0.1');
    assert.match(info.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(server.status().running, true);

    const unauthorized = await post(info.endpoint, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(unauthorized.status, 401);

    const wrong = await post(info.endpoint, 'b'.repeat(48), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(wrong.status, 401);

    const authorized = await post(info.endpoint, info.bearerToken, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json() as { result?: { tools?: unknown[] } };
    assert.ok(Array.isArray(payload.result?.tools));
  } finally {
    await server.stop();
  }
});

test('MCP Gateway HTTP server exposes health without leaking bearer token', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'c'.repeat(48) });
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.equal('bearerToken' in payload, false);
  } finally {
    await server.stop();
  }
});

test('MCP Gateway HTTP server supports modern stateless discovery and legacy initialized notification', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'd'.repeat(48) });
  try {
    const discovery = await post(
      info.endpoint,
      info.bearerToken,
      { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: {} },
      { 'mcp-protocol-version': '2026-07-28' },
    );
    assert.equal(discovery.status, 200);
    const discoveryPayload = await discovery.json() as { result?: { protocolVersion?: string } };
    assert.equal(discoveryPayload.result?.protocolVersion, '2026-07-28');

    const notification = await post(
      info.endpoint,
      info.bearerToken,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    assert.equal(notification.status, 202);
  } finally {
    await server.stop();
  }
});

test('MCP Gateway HTTP server rejects unsupported routes, methods and media types', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'e'.repeat(48) });
  try {
    const missing = await fetch(`http://127.0.0.1:${info.port}/missing`);
    assert.equal(missing.status, 404);

    const method = await fetch(info.endpoint, { method: 'GET' });
    assert.equal(method.status, 405);

    const media = await fetch(info.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.bearerToken}`, 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(media.status, 415);
  } finally {
    await server.stop();
  }
});

test('MCP Gateway HTTP server returns bounded JSON-RPC parse errors', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'f'.repeat(48) });
  try {
    const response = await fetch(info.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.bearerToken}`, 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as { error?: { code?: number; message?: string } };
    assert.equal(payload.error?.code, -32700);
    assert.match(payload.error?.message ?? '', /valid JSON/);
  } finally {
    await server.stop();
  }
});

test('MCP Gateway HTTP server stop is idempotent', async () => {
  const server = gateway();
  await server.start({ bearerToken: 'g'.repeat(48) });
  assert.equal(await server.stop(), true);
  assert.equal(await server.stop(), false);
  assert.equal(server.status().running, false);
});


test('MCP Gateway HTTP server rejects oversized request ids and method names before dispatch', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'h'.repeat(48) });
  try {
    const longId = await post(info.endpoint, info.bearerToken, {
      jsonrpc: '2.0',
      id: 'x'.repeat(161),
      method: 'tools/list',
    });
    assert.equal(longId.status, 400);

    const longMethod = await post(info.endpoint, info.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'm'.repeat(129),
    });
    assert.equal(longMethod.status, 400);
  } finally {
    await server.stop();
  }
});


test('MCP Gateway trusted tunnel binding exposes the ephemeral credential only while running', async () => {
  const server = gateway();
  assert.throws(() => server.trustedTunnelBinding(), /não está em execução/);
  const info = await server.start({ bearerToken: 'z'.repeat(48) });
  try {
    assert.deepEqual(server.trustedTunnelBinding(), {
      endpoint: info.endpoint,
      bearerToken: 'z'.repeat(48),
    });
    assert.equal('bearerToken' in server.status(), false);
  } finally {
    await server.stop();
  }
  assert.throws(() => server.trustedTunnelBinding(), /não está em execução/);
});


test('MCP Gateway preflight validates discovery and tools through authenticated HTTP without exposing bearer', async () => {
  const server = gateway();
  const info = await server.start({ bearerToken: 'p'.repeat(48) });
  try {
    const result = await server.preflight();
    assert.equal(result.ok, true);
    assert.equal(result.protocolVersion, '2026-07-28');
    assert.equal(result.toolCount, 6);
    assert.equal(result.writeToolCount, 0);
    assert.equal(JSON.stringify(result).includes(info.bearerToken), false);
  } finally {
    await server.stop();
  }
});

test('MCP Gateway preflight fails closed while the server is stopped', async () => {
  const server = gateway();
  await assert.rejects(() => server.preflight(), /não está em execução/);
});


test('MCP Gateway preflight counts dynamic plugin tools and write annotations', async () => {
  const server = gatewayWithPluginTools();
  await server.start({ bearerToken: 'q'.repeat(48) });
  try {
    const result = await server.preflight();
    assert.equal(result.ok, true);
    assert.equal(result.protocolVersion, '2026-07-28');
    assert.equal(result.toolCount, 9);
    assert.equal(result.writeToolCount, 1);
  } finally {
    await server.stop();
  }
});


test('MCP Gateway preflight fails closed on an unexpected discovery protocol version', async () => {
  const protocol = {
    async handle(request: { id?: string | number | null; method: string }) {
      if (request.method === 'server/discover') {
        return { jsonrpc: '2.0', id: request.id ?? null, result: { protocolVersion: '2099-01-01' } };
      }
      return { jsonrpc: '2.0', id: request.id ?? null, result: { tools: [] as unknown[] } };
    },
  } as unknown as McpGatewayProtocol;
  const server = new McpGatewayHttpServer(protocol);
  await server.start({ bearerToken: 'r'.repeat(48) });
  try {
    await assert.rejects(() => server.preflight(), /versão de protocolo inesperada/);
  } finally {
    await server.stop();
  }
});

test('MCP Gateway preflight fails closed on a malformed tools catalog', async () => {
  const protocol = {
    async handle(request: { id?: string | number | null; method: string }) {
      if (request.method === 'server/discover') {
        return { jsonrpc: '2.0', id: request.id ?? null, result: { protocolVersion: '2026-07-28' } };
      }
      return { jsonrpc: '2.0', id: request.id ?? null, result: { tools: [{ description: 'missing name' }] } };
    },
  } as unknown as McpGatewayProtocol;
  const server = new McpGatewayHttpServer(protocol);
  await server.start({ bearerToken: 's'.repeat(48) });
  try {
    await assert.rejects(() => server.preflight(), /tool sem nome/);
  } finally {
    await server.stop();
  }
});
