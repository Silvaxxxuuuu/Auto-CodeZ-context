import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { pluginToolCatalog } from '../src/plugins/plugin-tool-catalog';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugin-gateway-'));
  const workspace = new WorkspaceRuntime(async () => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }]);
  const tools = new ShadowAwareToolRuntime(workspace);
  return {
    tools,
    cleanup: async () => {
      pluginToolCatalog.clear('test.plugin');
      await rm(root, { recursive: true, force: true });
    },
  };
}

function registerTool(risk: 'read' | 'write' | 'sensitive') {
  const [definition] = pluginToolCatalog.register('test.plugin', [{
    id: 'external_action',
    description: 'Execute one bounded action in the connected external application.',
    risk,
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
  }]);
  return definition.name;
}

test('plugin gateway exposes stable discovery and call tools to providers', async () => {
  const fx = await fixture();
  try {
    const definitions = fx.tools.listDefinitions();
    assert.ok(definitions.some((definition) => definition.name === 'plugin_list_tools'));
    assert.ok(definitions.some((definition) => definition.name === 'plugin_call'));
    const call = definitions.find((definition) => definition.name === 'plugin_call');
    assert.equal(call?.requiresApproval, false);
    assert.equal(call?.requiresWriteAccess, false);
  } finally {
    await fx.cleanup();
  }
});

test('read-risk plugin tool executes directly and receives authoritative execution context', async () => {
  const fx = await fixture();
  try {
    const name = registerTool('read');
    let received: unknown;
    pluginToolCatalog.configureExecutor(async (pluginId, toolId, input, context) => {
      received = { pluginId, toolId, input, context };
      return { connected: true };
    });

    const result = await fx.tools.execute('chat-a', 'project-a', 'read-only', {
      id: 'call-a',
      name: 'plugin_call',
      input: { tool: name, arguments: JSON.stringify({ target: 'scene' }) },
    }, 'run-a');

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output ?? '{}'), { connected: true });
    assert.deepEqual(received, {
      pluginId: 'test.plugin',
      toolId: 'external_action',
      input: { target: 'scene' },
      context: {
        chatId: 'chat-a',
        projectId: 'project-a',
        runId: 'run-a',
        permission: 'read-only',
      },
    });
  } finally {
    await fx.cleanup();
  }
});

test('write-risk plugin tool is blocked in read-only and requires approval in safe mode', async () => {
  const fx = await fixture();
  try {
    const name = registerTool('write');
    let executions = 0;
    pluginToolCatalog.configureExecutor(async () => {
      executions += 1;
      return { changed: true };
    });

    const blocked = await fx.tools.execute('chat-a', 'project-a', 'read-only', {
      id: 'call-readonly',
      name: 'plugin_call',
      input: { tool: name, arguments: JSON.stringify({ target: 'scene' }) },
    }, 'run-a');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? '', /read-only/);
    assert.equal(executions, 0);

    const pending = await fx.tools.execute('chat-a', 'project-a', 'safe', {
      id: 'call-safe',
      name: 'plugin_call',
      input: { tool: name, arguments: JSON.stringify({ target: 'scene' }) },
    }, 'run-a');
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    assert.equal(executions, 0);

    const approved = await fx.tools.approve(pending.approvalId as string);
    assert.equal(approved.ok, true);
    assert.deepEqual(JSON.parse(approved.output ?? '{}'), { changed: true });
    assert.equal(executions, 1);
  } finally {
    await fx.cleanup();
  }
});

test('approved plugin action fails closed when its tool disappears before approval', async () => {
  const fx = await fixture();
  try {
    const name = registerTool('sensitive');
    let executions = 0;
    pluginToolCatalog.configureExecutor(async () => {
      executions += 1;
      return { changed: true };
    });

    const pending = await fx.tools.execute('chat-a', 'project-a', 'ask', {
      id: 'call-sensitive',
      name: 'plugin_call',
      input: { tool: name, arguments: JSON.stringify({ target: 'scene' }) },
    }, 'run-a');
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);

    pluginToolCatalog.clear('test.plugin');
    const approved = await fx.tools.approve(pending.approvalId as string);
    assert.equal(approved.ok, false);
    assert.match(approved.error ?? '', /não está mais disponível/);
    assert.equal(executions, 0);
  } finally {
    await fx.cleanup();
  }
});

test('plugin_list_tools returns bounded metadata without invoking any plugin', async () => {
  const fx = await fixture();
  try {
    const name = registerTool('read');
    let executions = 0;
    pluginToolCatalog.configureExecutor(async () => {
      executions += 1;
      return null;
    });

    const result = await fx.tools.execute('chat-a', 'project-a', 'read-only', {
      id: 'list-a',
      name: 'plugin_list_tools',
      input: {},
    }, 'run-a');

    assert.equal(result.ok, true);
    const listed = JSON.parse(result.output ?? '[]') as Array<Record<string, unknown>>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, name);
    assert.equal(listed[0].pluginId, 'test.plugin');
    assert.equal(listed[0].id, 'external_action');
    assert.equal(listed[0].risk, 'read');
    assert.equal(executions, 0);
  } finally {
    await fx.cleanup();
  }
});
