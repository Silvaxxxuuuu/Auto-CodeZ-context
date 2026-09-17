import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PluginMcpStdioRuntime, resolveRobloxStudioMcpCommand, type McpSpawn } from '../src/plugins/plugin-mcp-stdio-runtime';

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

test('MCP stdio transport rejects unsafe command and bounded input before spawning', async () => {
  let spawns = 0;
  const runtime = new PluginMcpStdioRuntime((() => { spawns += 1; throw new Error('should not spawn'); }) as McpSpawn);
  await assert.rejects(runtime.connect('plugin.a', { command: 'bad\ncommand' }), /Comando MCP inválido/);
  await assert.rejects(runtime.connect('plugin.a', { command: 'server', args: new Array(65).fill('x') }), /Argumentos MCP inválidos/);
  assert.equal(spawns, 0);
});


test('Roblox Studio MCP resolver fails clearly when Windows discovery prerequisites are missing', () => {
  assert.throws(() => resolveRobloxStudioMcpCommand('win32', {}), /LOCALAPPDATA/);
  assert.equal(resolveRobloxStudioMcpCommand('linux', {}), 'roblox-studio-mcp');
});


test('trusted Windows batch mode rejects non-batch launchers before spawning', async () => {
  let spawns = 0;
  const runtime = new PluginMcpStdioRuntime((() => { spawns += 1; throw new Error('should not spawn'); }) as McpSpawn);
  await assert.rejects(runtime.connect('roblox', { command: 'C:\\\\Roblox\\\\not-mcp.exe', windowsBatch: true }), /arquivo \\.bat/i);
  assert.equal(spawns, 0);
});
