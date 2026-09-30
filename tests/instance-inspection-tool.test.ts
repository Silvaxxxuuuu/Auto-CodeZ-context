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

test('inspect_instance reads bounded preview DOM metadata and enforces project isolation', async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-inspect-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-inspect-b-'));
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'A', rootPath: rootA, createdAt: 1, updatedAt: 1 },
    { id: 'project-b', name: 'B', rootPath: rootB, createdAt: 1, updatedAt: 1 },
  ];
  let inspections = 0;
  let open = true;
  const runtime = new InstanceRuntime({
    async open({ kind }): Promise<InstancePlatformHandle> {
      if (kind === 'url') return { canFocus: false, canClose: false };
      return {
        canFocus: true,
        canClose: true,
        close: () => { open = false; },
        isOpen: () => open,
        inspect: async () => {
          inspections += 1;
          return {
            title: 'T'.repeat(400),
            url: 'http://127.0.0.1:3000',
            text: 'A'.repeat(15000),
            headings: Array.from({ length: 90 }, () => ({ level: 2, text: 'H'.repeat(350) })),
            links: Array.from({ length: 120 }, () => ({ text: 'Link', href: 'http://127.0.0.1:3000/#section' })),
          };
        },
      };
    },
  });
  const tools = new ToolRuntime(new WorkspaceRuntime(async () => projects));
  tools.configureInstanceRuntime(runtime);

  try {
    const opened = await tools.execute('a', 'project-a', 'unrestricted', call('open', 'open_instance', {
      kind: 'preview', target: 'http://127.0.0.1:3000',
    }), 'run-a');
    assert.equal(opened.ok, true, opened.error);
    const { instanceId } = JSON.parse(opened.output ?? '{}') as { instanceId: string };
    const foreign = await tools.execute('b', 'project-b', 'read-only', call('foreign', 'inspect_instance', { instanceId }), 'run-b');
    assert.equal(foreign.ok, false);
    assert.match(foreign.error ?? '', /outro projeto/i);
    assert.equal(inspections, 0);

    const inspected = await tools.execute('a', 'project-a', 'read-only', call('inspect', 'inspect_instance', { instanceId }), 'run-a');
    assert.equal(inspected.ok, true, inspected.error);
    assert.equal(inspected.pendingApproval, undefined);
    const data = JSON.parse(inspected.output ?? '{}');
    assert.equal(data.type, 'preview_inspection');
    assert.equal(data.visualAnalysis, 'dom_only_not_pixel_vision');
    assert.equal(data.title.length, 250);
    assert.equal(data.text.length, 12000);
    assert.equal(data.headings.length, 60);
    assert.equal(data.headings[0].text.length, 250);
    assert.equal(data.links.length, 100);
    assert.equal(inspections, 1);

    const external = await tools.execute('a', 'project-a', 'unrestricted', call('external', 'open_instance', {
      kind: 'url', target: 'https://example.com',
    }), 'run-a');
    assert.equal(external.ok, true);
    const externalId = (JSON.parse(external.output ?? '{}') as { instanceId: string }).instanceId;
    const denied = await tools.execute('a', 'project-a', 'read-only', call('denied', 'inspect_instance', { instanceId: externalId }), 'run-a');
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? '', /não oferece inspeção controlada/i);

    open = false;
    const closed = await tools.execute('a', 'project-a', 'read-only', call('closed', 'inspect_instance', { instanceId }), 'run-a');
    assert.equal(closed.ok, false);
    assert.equal(inspections, 1);
  } finally {
    const opts = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 50 : 0, retryDelay: 100 };
    await fs.rm(rootA, opts);
    await fs.rm(rootB, opts);
  }
});

test('inspect rejects malformed platform payload and closure during inspection', async () => {
  let open = true;
  const deferred: { resolve?: (value: unknown) => void } = {};
  const runtime = new InstanceRuntime({
    async open(): Promise<InstancePlatformHandle> {
      return {
        canFocus: false,
        canClose: false,
        isOpen: () => open,
        inspect: () => new Promise((resolve) => { deferred.resolve = resolve; }),
      };
    },
  });
  const first = await runtime.open({ projectId: 'project', kind: 'preview', target: 'http://localhost:3000' });
  const pending = runtime.inspect(first.instanceId);
  open = false;
  assert.ok(deferred.resolve);
  deferred.resolve({ title: 'Page', url: 'http://localhost:3000', text: 'Text', headings: [], links: [] });
  await assert.rejects(pending, /fechada durante a inspeção/i);
  assert.equal(runtime.get(first.instanceId).status, 'closed');

  const malformed = new InstanceRuntime({
    async open(): Promise<InstancePlatformHandle> {
      return { canFocus: false, canClose: false, inspect: async () => ({ title: 'Page' } as never) };
    },
  });
  const second = await malformed.open({ projectId: 'project', kind: 'preview', target: 'http://localhost:3000' });
  await assert.rejects(malformed.inspect(second.instanceId), /inspeção inválida/i);
});
