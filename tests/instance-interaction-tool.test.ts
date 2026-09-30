import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';
import { InstanceRuntime, type InstancePlatformHandle } from '../src/agent/instance-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('interact_instance respects project, permission, action, selector and closed lifecycle', async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-interact-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-interact-b-'));
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'A', rootPath: rootA, createdAt: 1, updatedAt: 1 },
    { id: 'project-b', name: 'B', rootPath: rootB, createdAt: 1, updatedAt: 1 },
  ];
  let clicks = 0;
  let open = true;
  const instances = new InstanceRuntime({
    async open({ kind }): Promise<InstancePlatformHandle> {
      if (kind !== 'preview') return { canFocus: false, canClose: false };
      return {
        canFocus: true, canClose: true, close: () => { open = false; }, isOpen: () => open,
        interact: async (input) => {
          clicks += 1;
          return { ...input, executed: true };
        },
      };
    },
  });
  const tools = new ToolRuntime(new WorkspaceRuntime(async () => projects));
  tools.configureInstanceRuntime(instances);
  const opts = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 50 : 0, retryDelay: 100 };
  try {
    const started = await tools.execute('a', 'project-a', 'unrestricted', call('open', 'open_instance', {
      kind: 'preview', target: 'http://localhost:5173',
    }), 'run-a');
    assert.equal(started.ok, true, started.error);
    const instanceId = (JSON.parse(started.output ?? '{}') as { instanceId: string }).instanceId;
    const input = { instanceId, action: 'click_button', selector: '#refresh' };

    const foreign = await tools.execute('b', 'project-b', 'unrestricted', call('foreign', 'interact_instance', input), 'run-b');
    assert.equal(foreign.ok, false);
    assert.match(foreign.error ?? '', /outro projeto/i);
    const denied = await tools.execute('a', 'project-a', 'read-only', call('denied', 'interact_instance', input), 'run-read');
    assert.equal(denied.ok, false);
    const pending = await tools.execute('a', 'project-a', 'ask', call('ask', 'interact_instance', input), 'run-ask');
    assert.equal(pending.pendingApproval, true);
    assert.equal(clicks, 0);
    tools.deny(pending.approvalId as string);

    const invalid = await tools.execute('a', 'project-a', 'unrestricted', call('bad', 'interact_instance', {
      ...input, action: 'run_script',
    }), 'run-a');
    assert.equal(invalid.ok, false);
    const oversized = await tools.execute('a', 'project-a', 'unrestricted', call('long', 'interact_instance', {
      ...input, selector: 'a'.repeat(257),
    }), 'run-a');
    assert.equal(oversized.ok, false);
    assert.equal(clicks, 0);

    const clicked = await tools.execute('a', 'project-a', 'unrestricted', call('click', 'interact_instance', input), 'run-a');
    assert.equal(clicked.ok, true, clicked.error);
    assert.deepEqual(JSON.parse(clicked.output ?? '{}'), {
      type: 'preview_interaction', instanceId, action: 'click_button', selector: '#refresh', executed: true,
    });
    assert.equal(clicks, 1);
    open = false;
    const closed = await tools.execute('a', 'project-a', 'unrestricted', call('closed', 'interact_instance', input), 'run-a');
    assert.equal(closed.ok, false);
    assert.equal(clicks, 1);
  } finally {
    await fs.rm(rootA, opts);
    await fs.rm(rootB, opts);
  }
});

test('external instances have no interaction and platform results are validated', async () => {
  const runtime = new InstanceRuntime({
    async open({ kind }): Promise<InstancePlatformHandle> {
      return kind === 'preview'
        ? { canFocus: false, canClose: false, interact: async () => ({ action: 'click_button', selector: '#wrong', executed: true }) }
        : { canFocus: false, canClose: false };
    },
  });
  const external = await runtime.open({ projectId: 'a', kind: 'url', target: 'https://example.com' });
  await assert.rejects(() => runtime.interact(external.instanceId, { action: 'click_button', selector: '#button' }), /não oferece interação controlada/i);
  const remotePreview = await runtime.open({ projectId: 'a', kind: 'preview', target: 'https://example.com' });
  await assert.rejects(() => runtime.interact(remotePreview.instanceId, { action: 'click_button', selector: '#button' }), /somente loopback local/i);
  const preview = await runtime.open({ projectId: 'a', kind: 'preview', target: 'http://localhost:3000' });
  await assert.rejects(() => runtime.interact(preview.instanceId, { action: 'click_button', selector: '#button' }), /resultado de interação inválido/i);
});
