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

async function fixture() {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-instance-tool-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-instance-tool-b-'));
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'A', rootPath: rootA, createdAt: 1, updatedAt: 1 },
    { id: 'project-b', name: 'B', rootPath: rootB, createdAt: 1, updatedAt: 1 },
  ];
  const focused: string[] = [];
  const closed: string[] = [];
  const instances = new InstanceRuntime({
    open: async ({ instanceId, kind }): Promise<InstancePlatformHandle> => {
      if (kind !== 'preview') return { canFocus: false, canClose: false };
      let open = true;
      return {
        canFocus: true,
        canClose: true,
        focus: () => { focused.push(instanceId); },
        close: () => { open = false; closed.push(instanceId); },
        isOpen: () => open,
      };
    },
  });
  const workspace = new WorkspaceRuntime(async () => projects);
  const tools = new ToolRuntime(workspace);
  tools.configureInstanceRuntime(instances);
  return {
    tools,
    instances,
    focused,
    closed,
    cleanup: async () => {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    },
  };
}

test('ToolRuntime exposes preview instance lifecycle without approvals in unrestricted mode', async () => {
  const f = await fixture();
  try {
    const opened = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('open', 'open_instance', {
      kind: 'preview',
      target: 'http://localhost:5173',
    }), 'run-a');
    assert.equal(opened.ok, true);
    assert.equal(opened.pendingApproval, undefined);
    const snapshot = JSON.parse(opened.output ?? '{}');
    assert.equal(snapshot.projectId, 'project-a');
    assert.equal(snapshot.status, 'open');
    assert.deepEqual(snapshot.capabilities, { focus: true, close: true });

    const status = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('status', 'instance_status', {
      instanceId: snapshot.instanceId,
    }), 'run-a');
    assert.equal(status.ok, true);
    assert.equal(JSON.parse(status.output ?? '{}').status, 'open');

    const focused = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('focus', 'focus_instance', {
      instanceId: snapshot.instanceId,
    }), 'run-a');
    assert.equal(focused.ok, true);
    assert.deepEqual(f.focused, [snapshot.instanceId]);

    const listed = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('list', 'list_instances', {}), 'run-a');
    assert.equal(listed.ok, true);
    assert.deepEqual(JSON.parse(listed.output ?? '[]').map((item: { instanceId: string }) => item.instanceId), [snapshot.instanceId]);

    const closed = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('close', 'close_instance', {
      instanceId: snapshot.instanceId,
    }), 'run-a');
    assert.equal(closed.ok, true);
    assert.equal(JSON.parse(closed.output ?? '{}').status, 'closed');
    assert.deepEqual(f.closed, [snapshot.instanceId]);
    assert.equal(f.tools.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
  } finally {
    await f.cleanup();
  }
});

test('instance lifecycle tools cannot cross project boundaries and list stays workspace-scoped', async () => {
  const f = await fixture();
  try {
    const opened = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('open-a', 'open_instance', {
      kind: 'preview',
      target: 'http://localhost:4173',
    }), 'run-a');
    const instanceId = JSON.parse(opened.output ?? '{}').instanceId as string;

    for (const name of ['instance_status', 'focus_instance', 'close_instance'] as const) {
      const result = await f.tools.execute('chat-b', 'project-b', 'unrestricted', call(`cross-${name}`, name, { instanceId }), 'run-b');
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /outro projeto/i);
    }

    const listed = await f.tools.execute('chat-b', 'project-b', 'unrestricted', call('list-b', 'list_instances', {}), 'run-b');
    assert.equal(listed.ok, true);
    assert.deepEqual(JSON.parse(listed.output ?? '[]'), []);
    assert.equal(f.instances.get(instanceId).status, 'open');
  } finally {
    await f.instances.closeAll().catch(() => undefined);
    await f.cleanup();
  }
});

test('external instance kinds do not pretend focus or close control', async () => {
  const f = await fixture();
  try {
    const opened = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('open-url', 'open_instance', {
      kind: 'url',
      target: 'https://example.com',
    }), 'run-a');
    const snapshot = JSON.parse(opened.output ?? '{}');
    assert.deepEqual(snapshot.capabilities, { focus: false, close: false });

    const focus = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('focus-url', 'focus_instance', {
      instanceId: snapshot.instanceId,
    }), 'run-a');
    assert.equal(focus.ok, false);
    assert.match(focus.error ?? '', /não oferece controle de foco/i);

    const close = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('close-url', 'close_instance', {
      instanceId: snapshot.instanceId,
    }), 'run-a');
    assert.equal(close.ok, false);
    assert.match(close.error ?? '', /não oferece controle de fechamento/i);
  } finally {
    await f.cleanup();
  }
});

test('open_instance and close_instance require approval in ask mode while unrestricted stays approval-free', async () => {
  const f = await fixture();
  try {
    const pendingOpen = await f.tools.execute('chat-a', 'project-a', 'ask', call('open-ask', 'open_instance', {
      kind: 'preview',
      target: 'http://localhost:3000',
    }), 'run-a');
    assert.equal(pendingOpen.pendingApproval, true);
    assert.equal(f.instances.list('project-a').length, 0);

    const approvedOpen = await f.tools.approve(pendingOpen.approvalId as string);
    assert.equal(approvedOpen.ok, true);
    const instanceId = JSON.parse(approvedOpen.output ?? '{}').instanceId as string;

    const pendingClose = await f.tools.execute('chat-a', 'project-a', 'ask', call('close-ask', 'close_instance', {
      instanceId,
    }), 'run-a');
    assert.equal(pendingClose.pendingApproval, true);
    assert.equal(f.instances.get(instanceId).status, 'open');

    const approvedClose = await f.tools.approve(pendingClose.approvalId as string);
    assert.equal(approvedClose.ok, true);
    assert.equal(f.instances.get(instanceId).status, 'closed');
  } finally {
    await f.cleanup();
  }
});

test('read-only mode permits instance reads but blocks open_instance', async () => {
  const f = await fixture();
  try {
    const blocked = await f.tools.execute('chat-a', 'project-a', 'read-only', call('open-readonly', 'open_instance', {
      kind: 'preview',
      target: 'http://localhost:8080',
    }), 'run-a');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? '', /permissões do chat/i);

    const listed = await f.tools.execute('chat-a', 'project-a', 'read-only', call('list-readonly', 'list_instances', {}), 'run-a');
    assert.equal(listed.ok, true);
    assert.deepEqual(JSON.parse(listed.output ?? '[]'), []);
  } finally {
    await f.cleanup();
  }
});
