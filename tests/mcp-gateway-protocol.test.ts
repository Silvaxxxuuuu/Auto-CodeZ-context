import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalLedger } from '../src/operational-ledger';
import { OperationalLedgerRetrieval } from '../src/operational-ledger-retrieval';
import type { AgentRuntime } from '../src/agent/agent-runtime';
import { McpGatewayExecutionRuntime } from '../src/mcp-gateway/execution-runtime';
import { MCP_GATEWAY_PROTOCOL_VERSION, McpGatewayProtocol } from '../src/mcp-gateway/protocol';
import { PluginToolCatalog } from '../src/plugins/plugin-tool-catalog';

function fixture() {
  const ledger = new OperationalLedger();
  ledger.record({
    actor: 'runtime',
    category: 'execution',
    state: 'running',
    summary: 'Execução iniciada.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    providerId: 'openai',
    clientId: 'autocodez-chat',
    timestamp: 1000,
  });
  ledger.record({
    actor: 'plugin',
    category: 'artifact',
    state: 'success',
    summary: 'Artifact produzido.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    pluginId: 'autocodez.roblox-studio-manager',
    artifactIds: ['artifact-a'],
    timestamp: 1200,
  });
  ledger.record({
    actor: 'plugin',
    category: 'tool',
    state: 'failed',
    summary: 'Playtest falhou.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    pluginId: 'autocodez.roblox-studio-manager',
    toolName: 'run_playtest',
    error: 'capture failed',
    timestamp: 1400,
  });
  return new McpGatewayProtocol(new OperationalLedgerRetrieval(ledger));
}

test('MCP gateway advertises only bounded read-only retrieval tools in phase one', () => {
  const protocol = fixture();
  const listed = protocol.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(listed?.result);
  const tools = (listed.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'session_summary',
    'session_recent_events',
    'session_changes',
    'session_errors',
    'session_artifacts',
    'session_sources',
  ]);
  assert.equal(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false), true);
});

test('MCP gateway supports modern stateless server discovery', () => {
  const protocol = fixture();
  const response = protocol.handle({ jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: {} });
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 'discover',
    result: {
      protocolVersion: MCP_GATEWAY_PROTOCOL_VERSION,
      serverInfo: { name: 'Auto CodeZ MCP Gateway', version: '0.1.0' },
      capabilities: { tools: { listChanged: false } },
    },
  });
});

test('MCP gateway keeps legacy Streamable HTTP initialization compatible without mixing modern lifecycle', () => {
  const protocol = fixture();
  const legacy = protocol.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', clientInfo: { name: 'inspector', version: '1' } },
  });
  assert.equal((legacy?.result as { protocolVersion?: string }).protocolVersion, '2025-11-25');

  const modernOverInitialize = protocol.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: MCP_GATEWAY_PROTOCOL_VERSION },
  });
  assert.equal(modernOverInitialize?.error?.code, -32602);
});

test('MCP gateway executes session retrieval tools and preserves structured content', () => {
  const protocol = fixture();
  const response = protocol.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'session_summary',
      arguments: { scope: { chatId: 'chat-a', runId: 'run-a' } },
    },
  });
  assert.ok(response?.result);
  const result = response.result as { content: Array<{ type: string; text: string }>; structuredContent: { eventCount: number; artifactIds: string[]; errors: string[] }; isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.eventCount, 3);
  assert.deepEqual(result.structuredContent.artifactIds, ['artifact-a']);
  assert.deepEqual(result.structuredContent.errors, ['capture failed']);
  assert.equal(result.content[0].type, 'text');
});

test('MCP gateway rejects unknown tools and malformed bounded arguments', () => {
  const protocol = fixture();
  const unknown = protocol.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'delete_everything', arguments: {} },
  });
  assert.equal(unknown?.error?.code, -32602);

  const invalidScope = protocol.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'session_errors', arguments: { scope: { chatId: 'chat-a', secret: 'x' } } },
  });
  assert.equal(invalidScope?.error?.code, -32602);
});

test('MCP gateway ignores initialized notifications and rejects unsupported methods', () => {
  const protocol = fixture();
  assert.equal(protocol.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const unsupported = protocol.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(unsupported?.error?.code, -32601);
});


function executableProtocol(nextResult: { pendingApproval?: boolean; approvalId?: string; ok: boolean; output?: string; error?: string } = { ok: true, output: 'done' }) {
  const ledger = new OperationalLedger();
  const retrieval = new OperationalLedgerRetrieval(ledger);
  const catalog = new PluginToolCatalog();
  catalog.register('autocodez.roblox-studio-manager', [{
    id: 'run_playtest',
    description: 'Run a guarded Roblox Studio playtest.',
    risk: 'write',
    parameters: {
      type: 'object',
      properties: { studioId: { type: 'string', maxLength: 128 } },
      required: ['studioId'],
      additionalProperties: false,
    },
  }]);

  const calls: Array<Record<string, unknown>> = [];
  const agent = {
    async executeExternalTool(input: Record<string, unknown>) {
      calls.push(structuredClone(input));
      return { toolCallId: 'gateway-call', ...nextResult };
    },
    async approveExternalTool() {
      return { toolCallId: 'gateway-call', ok: true, output: 'approved' };
    },
    denyExternalTool() {
      return true;
    },
  } as unknown as AgentRuntime;

  const execution = new McpGatewayExecutionRuntime(agent, catalog);
  return { protocol: new McpGatewayProtocol(retrieval, execution), execution, calls };
}

test('MCP gateway lists dynamic plugin tools with write annotations and operation_status', () => {
  const fixture = executableProtocol();
  const response = fixture.protocol.handle({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
  const tools = (response?.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> }).tools;

  const playtest = tools.find((tool) => tool.name === 'roblox_run_playtest');
  assert.ok(playtest);
  assert.equal(playtest.annotations?.readOnlyHint, false);
  assert.equal(playtest.annotations?.destructiveHint, true);
  assert.ok(tools.some((tool) => tool.name === 'operation_status'));
});

test('MCP gateway executes dynamic plugin tools through the external execution runtime', async () => {
  const fixture = executableProtocol();
  const response = await fixture.protocol.handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'roblox_run_playtest',
      arguments: { studioId: 'studio-a' },
      _meta: {
        'io.modelcontextprotocol/clientInfo': { name: 'ChatGPT', version: 'test' },
      },
    },
  });

  const result = response?.result as { structuredContent?: { state?: string; chatId?: string; operationId?: string } };
  assert.equal(result.structuredContent?.state, 'success');
  assert.equal(result.structuredContent?.chatId, 'mcp:ChatGPT');
  assert.ok(result.structuredContent?.operationId);
  assert.equal(fixture.calls.length, 1);
});

test('MCP gateway returns waiting approval and exposes operation status for external writes', async () => {
  const fixture = executableProtocol({ ok: false, pendingApproval: true, approvalId: 'approval-a', error: 'waiting' });
  const call = await fixture.protocol.handle({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'roblox_run_playtest',
      arguments: { studioId: 'studio-a' },
    },
  });
  const operation = (call?.result as { structuredContent?: { operationId?: string; state?: string; approvalId?: string } }).structuredContent;
  assert.equal(operation?.state, 'waiting_approval');
  assert.equal(operation?.approvalId, 'approval-a');
  assert.ok(operation?.operationId);

  const status = fixture.protocol.handle({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'operation_status',
      arguments: { operationId: operation?.operationId },
    },
  });
  const statusOperation = (status?.result as { structuredContent?: { state?: string; approvalId?: string } }).structuredContent;
  assert.equal(statusOperation?.state, 'waiting_approval');
  assert.equal(statusOperation?.approvalId, 'approval-a');
});
