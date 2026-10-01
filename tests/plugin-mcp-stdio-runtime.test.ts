import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PluginMcpStdioRuntime, buildRobloxStudioLaunchPlan, resolveRobloxStudioMcpCommand, type McpSpawn } from '../src/plugins/plugin-mcp-stdio-runtime';

type FakeServer = {
  child: ChildProcessWithoutNullStreams;
  requests: Array<{ jsonrpc: string; id?: number; method: string; params?: unknown }>;
  notifications: Array<{ method: string; params?: unknown }>;
  exit(code?: number): void;
};

function fakeServer(onRequest: (message: { id: number; method: string; params?: unknown }, reply: (result?: unknown, error?: { code: number; message: string }) => void) => void): { spawn: McpSpawn; server: FakeServer } {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, { stdin, stdout, stderr, pid: 4242, kill: () => { emitter.emit('exit', 0, null); return true; } });
  const requests: FakeServer['requests'] = [];
  const notifications: FakeServer['notifications'] = [];
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line) as { jsonrpc: string; id?: number; method: string; params?: unknown };
        requests.push(message);
        if (typeof message.id === 'number') {
          onRequest({ id: message.id, method: message.method, params: message.params }, (result, error) => {
            stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) }) + '\n');
          });
        } else notifications.push({ method: message.method, params: message.params });
      }
      newline = buffer.indexOf('\n');
    }
  });
  const server: FakeServer = {
    child: emitter,
    requests,
    notifications,
    exit(code = 0) { emitter.emit('exit', code, null); },
  };
  return { spawn: (() => emitter) as McpSpawn, server };
}

test('MCP stdio transport performs initialize, initialized, tools/list and tools/call', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'Roblox Studio', version: '1.0.0' }, capabilities: { tools: {} } });
      return;
    }
    if (message.method === 'tools/list') {
      reply({ tools: [{ name: 'search_game_tree', description: 'Inspect the game tree.', inputSchema: { type: 'object' } }] });
      return;
    }
    if (message.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'Workspace' }], isError: false });
      return;
    }
    reply(undefined, { code: -32601, message: 'Method not found' });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('roblox.studio-manager', { command: 'mcp.bat' });
  assert.equal(connected.serverName, 'Roblox Studio');
  assert.equal(connected.protocolVersion, '2025-06-18');
  assert.equal(fixture.server.requests[0]?.method, 'initialize');
  assert.equal(fixture.server.notifications[0]?.method, 'notifications/initialized');

  const tools = await runtime.listTools('roblox.studio-manager', connected.sessionId) as { tools: Array<{ name: string }> };
  assert.equal(tools.tools[0]?.name, 'search_game_tree');

  const result = await runtime.callTool('roblox.studio-manager', connected.sessionId, 'search_game_tree', { path: 'game.Workspace' }) as { isError: boolean };
  assert.equal(result.isError, false);
  const call = fixture.server.requests.find((request) => request.method === 'tools/call');
  assert.deepEqual(call?.params, { name: 'search_game_tree', arguments: { path: 'game.Workspace' } });

  assert.equal(runtime.disconnect('roblox.studio-manager', connected.sessionId), true);
  assert.equal(runtime.disconnect('roblox.studio-manager', connected.sessionId), false);
});

test('MCP stdio runtime aggregates paginated tool catalogs', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
    if (message.method === 'tools/list') {
      const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
      return cursor === 'page-2'
        ? reply({ tools: [{ name: 'second', inputSchema: { type: 'object' } }] })
        : reply({ tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page-2' });
    }
    reply({});
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  const listed = await runtime.listTools('test.plugin', connected.sessionId);
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['first', 'second']);
  const listRequests = fixture.server.requests.filter((request) => request.method === 'tools/list');
  assert.deepEqual(listRequests.map((request) => request.params), [{}, { cursor: 'page-2' }]);
  runtime.disconnectPlugin('test.plugin');
});

test('MCP stdio runtime bounds aggregate tool catalogs across pagination', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
    if (message.method === 'tools/list') {
      const cursor = Number((message.params as { cursor?: string } | undefined)?.cursor ?? '0');
      const tools = Array.from({ length: 64 }, (_, index) => ({ name: 'tool_' + cursor + '_' + index, inputSchema: { type: 'object' } }));
      return reply({ tools, nextCursor: cursor < 4 ? String(cursor + 1) : undefined });
    }
    reply({});
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  await assert.rejects(() => runtime.listTools('test.plugin', connected.sessionId), /limite de 256 tools/);
  runtime.disconnectPlugin('test.plugin');
});

test('MCP stdio runtime rejects duplicate tools across pages', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
    if (message.method === 'tools/list') {
      const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
      return cursor ? reply({ tools: [{ name: 'same' }] }) : reply({ tools: [{ name: 'same' }], nextCursor: 'next' });
    }
    reply({});
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  await assert.rejects(() => runtime.listTools('test.plugin', connected.sessionId), /tool duplicada/);
  runtime.disconnectPlugin('test.plugin');
});

test('MCP stdio sessions are isolated by plugin and fail closed after server exit', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'Test MCP', version: '1' } });
    else if (message.method === 'tools/list') setTimeout(() => reply({ tools: [] }), 50);
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('plugin.a', { command: 'server' });
  await assert.rejects(runtime.listTools('plugin.b', connected.sessionId), /não encontrada/i);
  const pending = runtime.listTools('plugin.a', connected.sessionId);
  fixture.server.exit(17);
  await assert.rejects(pending, /encerrou|código/i);
  await assert.rejects(runtime.listTools('plugin.a', connected.sessionId), /não encontrada/i);
});

test('MCP stdio runtime ignores server notifications and rejects unsupported server requests', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  (fixture.server.child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
  (fixture.server.child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'roots/list', params: {} }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.status('test.plugin', connected.sessionId).connected, true);
  const response = fixture.server.requests.find((message) => message.id === undefined && message.method === undefined);
  assert.equal(response, undefined);
  const rawWrites: string[] = [];
  const capture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
  });
  let raw = '';
  capture.server.child.stdin.on('data', (chunk) => { raw += String(chunk); });
  const second = new PluginMcpStdioRuntime(capture.spawn);
  const secondConnected = await second.connect('test.plugin', { command: 'fake' });
  (capture.server.child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', id: 'server-2', method: 'roots/list' }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  for (const line of raw.split('\n')) if (line.trim()) rawWrites.push(line);
  assert.ok(rawWrites.some((line) => {
    const message = JSON.parse(line) as { id?: unknown; error?: { code?: number } };
    return message.id === 'server-2' && message.error?.code === -32601;
  }));
  runtime.disconnectPlugin('test.plugin');
  second.disconnectPlugin('test.plugin');
});

test('MCP stdio runtime reports authoritative live session status and clears it on exit', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'Roblox Studio', version: '2.1' } });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  assert.deepEqual(runtime.status('test.plugin', connected.sessionId), {
    connected: true,
    protocolVersion: '2025-06-18',
    serverName: 'Roblox Studio',
    serverVersion: '2.1',
  });
  fixture.server.exit(0);
  assert.deepEqual(runtime.status('test.plugin', connected.sessionId), { connected: false });
});

test('MCP stdio runtime rejects invalid initialize protocol versions', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: null, serverInfo: { name: 'broken' } });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  await assert.rejects(() => runtime.connect('test.plugin', { command: 'fake' }), /protocolVersion incompatível/);
});

test('MCP stdio runtime accepts the newer handshake-era protocol but rejects the modern lifecycle on initialize', async () => {
  const legacy = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-11-25', serverInfo: { name: 'legacy-new' } });
  });
  const runtime = new PluginMcpStdioRuntime(legacy.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  assert.equal(connected.protocolVersion, '2025-11-25');
  runtime.disconnectPlugin('test.plugin');

  const modern = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2026-07-28', serverInfo: { name: 'modern' } });
  });
  const modernRuntime = new PluginMcpStdioRuntime(modern.spawn);
  await assert.rejects(
    () => modernRuntime.connect('test.plugin', { command: 'fake' }),
    /protocolVersion incompatível com o transporte stdio legado/,
  );
});

test('MCP stdio runtime rejects malformed JSON and closes the session', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  (fixture.server.child.stdout as PassThrough).write('{not-json}\n');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => runtime.listTools('test.plugin', connected.sessionId), /não encontrada|encerrada/i);
});

test('MCP stdio runtime rejects an oversized single message without penalizing prior complete messages', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  (fixture.server.child.stdout as PassThrough).write('\n'.repeat(16));
  (fixture.server.child.stdout as PassThrough).write('x'.repeat(4 * 1024 * 1024 + 1));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => runtime.listTools('test.plugin', connected.sessionId), /não encontrada|encerrada/i);
});

test('MCP stdio runtime rejects tool-level isError results with bounded text detail', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
    if (message.method === 'tools/call') return reply({
      isError: true,
      content: [
        { type: 'text', text: 'Studio refused the operation' },
        { type: 'text', text: 'because Play is unavailable' },
      ],
    });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  await assert.rejects(
    () => runtime.callTool('test.plugin', connected.sessionId, 'start_stop_play', { mode: 'play' }),
    /Studio refused the operation\nbecause Play is unavailable/,
  );
  runtime.disconnectPlugin('test.plugin');
});

test('MCP stdio runtime uses a deterministic fallback for tool-level errors without text', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
    if (message.method === 'tools/call') return reply({ isError: true, content: [] });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  await assert.rejects(
    () => runtime.callTool('test.plugin', connected.sessionId, 'execute_luau', {}),
    /Tool MCP 'execute_luau' retornou erro/,
  );
  runtime.disconnectPlugin('test.plugin');
});

test('MCP stdio runtime surfaces JSON-RPC errors and request timeouts', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
    if (message.method === 'tools/list') return reply(undefined, { code: -32000, message: 'catalog unavailable' });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  await assert.rejects(() => runtime.listTools('test.plugin', connected.sessionId), /catalog unavailable/);
  runtime.disconnectPlugin('test.plugin');

  const hanging = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
  });
  const timeoutRuntime = new PluginMcpStdioRuntime(hanging.spawn);
  const timeoutConnected = await timeoutRuntime.connect('test.plugin', { command: 'fake' });
  await assert.rejects(() => timeoutRuntime.listTools('test.plugin', timeoutConnected.sessionId, 1000), /tempo limite/);
  await new Promise((resolve) => setImmediate(resolve));
  const timedOutRequest = hanging.server.requests.find((request) => request.method === 'tools/list');
  const cancellation = hanging.server.notifications.find((notification) => notification.method === 'notifications/cancelled');
  assert.ok(timedOutRequest?.id);
  assert.deepEqual(cancellation?.params, {
    requestId: timedOutRequest.id,
    reason: 'Auto CodeZ timeout: tools/list',
  });
  timeoutRuntime.disconnectPlugin('test.plugin');
});

test('MCP stdio runtime surfaces synchronous spawn failures without retaining a session', async () => {
  const runtime = new PluginMcpStdioRuntime((() => { throw new Error('ENOENT fake-server'); }) as McpSpawn);
  await assert.rejects(() => runtime.connect('test.plugin', { command: 'missing-server' }), /Não foi possível iniciar o servidor MCP: ENOENT fake-server/);
});

test('MCP stdio disconnect is idempotent around an already killed child', async () => {
  const fixture = fakeServer((message, reply) => {
    if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake' } });
  });
  const runtime = new PluginMcpStdioRuntime(fixture.spawn);
  const connected = await runtime.connect('test.plugin', { command: 'fake' });
  Object.defineProperty(fixture.server.child, 'killed', { value: true, configurable: true });
  assert.equal(runtime.disconnect('test.plugin', connected.sessionId), true);
  assert.equal(runtime.disconnect('test.plugin', connected.sessionId), false);
});

test('MCP stdio transport rejects unsafe command and bounded input before spawning', async () => {
  let spawns = 0;
  const runtime = new PluginMcpStdioRuntime((() => { spawns += 1; throw new Error('should not spawn'); }) as McpSpawn);
  await assert.rejects(runtime.connect('plugin.a', { command: 'bad\ncommand' }), /Comando MCP inválido/);
  await assert.rejects(runtime.connect('plugin.a', { command: 'server', args: new Array(65).fill('x') }), /Argumentos MCP inválidos/);
  assert.equal(spawns, 0);
});



test('trusted Roblox Studio launch plan owns Windows cmd invocation', () => {
  assert.deepEqual(buildRobloxStudioLaunchPlan('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'C:\\Users\\User\\AppData\\Local\\Roblox\\mcp.bat'), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'C:\\Users\\User\\AppData\\Local\\Roblox\\mcp.bat'],
  });
  assert.deepEqual(buildRobloxStudioLaunchPlan('darwin', {}, '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP'), {
    command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP',
    args: [],
  });
});

test('Roblox Studio MCP resolver fails clearly when Windows discovery prerequisites are missing', () => {
  assert.throws(() => resolveRobloxStudioMcpCommand('win32', {}), /LOCALAPPDATA/);
  assert.throws(() => resolveRobloxStudioMcpCommand('linux', {}), /apenas no Windows e macOS/);
});


