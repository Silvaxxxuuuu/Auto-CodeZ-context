import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIToolResult } from '../src/ai/types';
import type { AgentRuntime } from '../src/agent/agent-runtime';
import { McpGatewayExecutionRuntime } from '../src/mcp-gateway/execution-runtime';
import { OperationalLedger } from '../src/operational-ledger';
import { PluginToolCatalog } from '../src/plugins/plugin-tool-catalog';

function catalog() {
  const value = new PluginToolCatalog();
  value.register('autocodez.roblox-studio-manager', [
    {
      id: 'inspect_game',
      description: 'Inspect the connected Roblox Studio DataModel.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { studioId: { type: 'string', maxLength: 128 } },
        required: ['studioId'],
        additionalProperties: false,
      },
    },
    {
      id: 'run_playtest',
      description: 'Run a guarded visual playtest.',
      risk: 'write',
      parameters: {
        type: 'object',
        properties: { studioId: { type: 'string', maxLength: 128 } },
        required: ['studioId'],
        additionalProperties: false,
      },
    },
  ]);
  return value;
}

function fakeAgent() {
  const executions: Array<Record<string, unknown>> = [];
  const approvals: string[] = [];
  const denials: string[] = [];
  let next: AIToolResult = { toolCallId: '', ok: true, output: 'ok' };
  const agent = {
    async executeExternalTool(input: Record<string, unknown>) {
      executions.push(structuredClone(input));
      return structuredClone(next);
    },
    async approveExternalTool(approvalId: string) {
      approvals.push(approvalId);
      return { toolCallId: 'approved-call', ok: true, output: 'approved' };
    },
    denyExternalTool(approvalId: string) {
      denials.push(approvalId);
      return true;
    },
  } as unknown as AgentRuntime;
  return {
    agent,
    executions,
    approvals,
    denials,
    setNext(value: AIToolResult) { next = value; },
  };
}

test('MCP Gateway execution exposes stable Roblox tool names and preserves schemas', () => {
  const fixture = fakeAgent();
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, catalog());
  const tools = runtime.listTools();

  assert.deepEqual(tools.map((tool) => tool.name), ['roblox_inspect_game', 'roblox_run_playtest']);
  assert.equal(tools[0].risk, 'read');
  assert.equal(tools[1].risk, 'write');
  assert.deepEqual(tools[1].inputSchema, {
    type: 'object',
    properties: { studioId: { type: 'string', maxLength: 128 } },
    required: ['studioId'],
    additionalProperties: false,
  });
});

test('MCP Gateway execution routes plugin tools through AgentRuntime with ask permission', async () => {
  const fixture = fakeAgent();
  const plugins = catalog();
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, plugins);

  const operation = await runtime.execute('roblox_inspect_game', { studioId: 'studio-a' }, { clientId: 'ChatGPT' });
  assert.equal(operation.state, 'success');
  assert.equal(operation.chatId, 'mcp:ChatGPT');
  assert.equal(operation.permission, 'ask');
  assert.equal(fixture.executions.length, 1);

  const execution = fixture.executions[0] as {
    chatId: string;
    runId: string;
    permission: string;
    call: { name: string; input: { tool: string; arguments: string } };
  };
  assert.equal(execution.chatId, operation.chatId);
  assert.equal(execution.runId, operation.runId);
  assert.equal(execution.permission, 'ask');
  assert.equal(execution.call.name, 'plugin_call');
  const descriptor = plugins.list().find((tool) => tool.toolId === 'inspect_game');
  assert.equal(execution.call.input.tool, descriptor?.name);
  assert.deepEqual(JSON.parse(execution.call.input.arguments), { studioId: 'studio-a' });
});

test('MCP Gateway execution preserves approval lifecycle for write plugin tools', async () => {
  const fixture = fakeAgent();
  fixture.setNext({
    toolCallId: 'gateway-call',
    ok: false,
    pendingApproval: true,
    approvalId: 'approval-a',
    error: 'waiting',
  });
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, catalog());

  const pending = await runtime.execute('roblox_run_playtest', { studioId: 'studio-a' });
  assert.equal(pending.state, 'waiting_approval');
  assert.equal(pending.approvalId, 'approval-a');
  assert.equal(runtime.ownsApproval('approval-a'), true);
  assert.equal(runtime.operationForApproval('approval-a')?.operationId, pending.operationId);

  const approved = await runtime.approve('approval-a');
  assert.equal(approved.state, 'success');
  assert.equal(approved.approvalId, undefined);
  assert.equal(approved.result?.output, 'approved');
  assert.deepEqual(fixture.approvals, ['approval-a']);
  assert.equal(runtime.ownsApproval('approval-a'), false);
});

test('MCP Gateway execution records local denial and closes the approval', async () => {
  const fixture = fakeAgent();
  fixture.setNext({
    toolCallId: 'gateway-call',
    ok: false,
    pendingApproval: true,
    approvalId: 'approval-b',
  });
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, catalog());

  const pending = await runtime.execute('roblox_run_playtest', { studioId: 'studio-a' });
  const denied = runtime.deny('approval-b');

  assert.equal(denied.operationId, pending.operationId);
  assert.equal(denied.state, 'denied');
  assert.match(denied.result?.error ?? '', /denied by the user/);
  assert.deepEqual(fixture.denials, ['approval-b']);
  assert.equal(runtime.ownsApproval('approval-b'), false);
});

test('MCP Gateway execution rejects missing tools and stale approvals', async () => {
  const fixture = fakeAgent();
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, catalog());

  await assert.rejects(() => runtime.execute('roblox_missing', {}), /not found/);
  await assert.rejects(() => runtime.approve('missing-approval'), /not found/);
  assert.throws(() => runtime.deny('missing-approval'), /not found/);
});


test('MCP Gateway execution writes authoritative external client context to the ledger', async () => {
  const fixture = fakeAgent();
  const ledger = new OperationalLedger();
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, catalog(), ledger);

  const operation = await runtime.execute('roblox_inspect_game', { studioId: 'studio-a' }, { clientId: 'ChatGPT' });
  const events = ledger.query({ runId: operation.runId }).events;

  assert.equal(events.length, 2);
  assert.equal(events[0].actor, 'external');
  assert.equal(events[0].clientId, 'ChatGPT');
  assert.equal(events[0].chatId, 'mcp:ChatGPT');
  assert.equal(events[0].toolName, 'roblox_inspect_game');
  assert.equal(events[0].causationId, operation.operationId);
  assert.equal(events[0].state, 'running');
  assert.equal(events[1].state, 'success');
  assert.equal(events[1].causationId, operation.operationId);
});

test('MCP Gateway execution keeps approval decision events on the same operation causation chain', async () => {
  const fixture = fakeAgent();
  fixture.setNext({
    toolCallId: 'gateway-call',
    ok: false,
    pendingApproval: true,
    approvalId: 'approval-ledger',
  });
  const ledger = new OperationalLedger();
  const runtime = new McpGatewayExecutionRuntime(fixture.agent, catalog(), ledger);

  const pending = await runtime.execute('roblox_run_playtest', { studioId: 'studio-a' }, { clientId: 'ChatGPT' });
  await runtime.approve('approval-ledger');

  const events = ledger.query({ runId: pending.runId }).events;
  assert.equal(events.every((event) => event.causationId === pending.operationId), true);
  assert.equal(events.some((event) => event.state === 'waiting'), true);
  assert.equal(events.at(-1)?.state, 'success');
});
