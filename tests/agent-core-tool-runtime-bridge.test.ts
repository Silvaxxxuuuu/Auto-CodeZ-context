import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIToolCall } from '../src/ai/types';
import type { LocalStorage } from '../src/core/storage';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ShadowAwareWorkspaceRuntime } from '../src/agent/shadow-aware-workspace-runtime';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';
import { IncrementalWorkspaceMutationRuntime } from '../src/agent-core/incremental-workspace-runtime';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';
import { DurableOperationJournal, OperationJournalStore } from '../src/agent-core/operation-journal-store';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('Agent Core V2 bridge materializes create/write/local incremental edits while unmigrated mutations remain shadowed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-agent-core-bridge-'));
  try {
    await fs.writeFile(path.join(root, 'existing.txt'), 'base', 'utf8');
    await fs.writeFile(path.join(root, 'legacy-delete.txt'), 'keep', 'utf8');
    const base = new WorkspaceRuntime(async () => [{
      id: 'project-a',
      name: 'Project A',
      rootPath: root,
      createdAt: 1,
      updatedAt: 1,
    }]);
    const shadows = new ExecutionShadowWorkspaceRuntime(base);
    const shadowWorkspace = new ShadowAwareWorkspaceRuntime(base, shadows);
    const runtime = new ShadowAwareToolRuntime(shadowWorkspace);
    runtime.configureShadowWorkspace(shadows);

    const storage = new MemoryStorage();
    const journalRuntime = new OperationJournalRuntime({ createId: (() => { let value = 0; return () => `op-${++value}`; })() });
    const durable = new DurableOperationJournal(journalRuntime, new OperationJournalStore(storage as unknown as LocalStorage));
    await durable.init();
    const blobs = new Map<string, string>();
    const rollbackBlobs = {
      putText: async (content: string) => {
        const ref = `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`;
        blobs.set(ref, content);
        return ref;
      },
      getText: async (ref: string) => {
        const content = blobs.get(ref);
        if (content === undefined) throw new Error('missing rollback blob');
        return content;
      },
    };
    runtime.configureIncrementalWorkspaceRuntime(new IncrementalWorkspaceMutationRuntime(base, durable, rollbackBlobs));

    const folder = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('folder', 'create_folder', { path: 'site/assets' }), 'run-a');
    assert.equal(folder.ok, true);
    assert.equal((await base.statPath('project-a', 'site/assets')).exists, true);
    assert.equal(shadows.get('chat-a', 'run-a'), undefined);

    const created = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('file', 'create_file', { path: 'site/src/index.html', content: '<h1>real</h1>' }), 'run-a');
    assert.equal(created.ok, true);
    assert.equal(await base.readFile('project-a', 'site/src/index.html'), '<h1>real</h1>');
    assert.equal(shadows.get('chat-a', 'run-a'), undefined);

    const updated = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('write', 'write_file', { path: 'existing.txt', content: 'real-write' }), 'run-a');
    assert.equal(updated.ok, true);
    assert.equal(await base.readFile('project-a', 'existing.txt'), 'real-write');
    assert.equal(shadows.get('chat-a', 'run-a'), undefined);

    const incrementalEdit = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('edit', 'replace_text', { path: 'existing.txt', oldText: 'real-write', newText: 'real-edit' }), 'run-a');
    assert.equal(incrementalEdit.ok, true);
    assert.equal(await base.readFile('project-a', 'existing.txt'), 'real-edit');
    assert.equal(shadows.get('chat-a', 'run-a'), undefined);

    const legacyDelete = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('delete', 'delete_file', { path: 'legacy-delete.txt' }), 'run-a');
    assert.equal(legacyDelete.ok, true);
    assert.equal(await base.readFile('project-a', 'legacy-delete.txt'), 'keep');
    assert.equal(shadows.get('chat-a', 'run-a')?.changes.some((change) => change.path === 'legacy-delete.txt' && change.type === 'deleted'), true);

    const operations = durable.list({ runId: 'run-a' });
    assert.equal(operations.length, 4);
    assert.deepEqual(operations.map((item) => item.capabilityId), ['workspace.create_folder', 'workspace.create_file', 'workspace.write_file', 'workspace.write_file']);
    assert.equal(operations.every((item) => item.status === 'verified'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('create_file preview refuses a path that only exists in a legacy shadow overlay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-agent-core-bridge-shadow-'));
  try {
    const base = new WorkspaceRuntime(async () => [{
      id: 'project-a',
      name: 'Project A',
      rootPath: root,
      createdAt: 1,
      updatedAt: 1,
    }]);
    const shadows = new ExecutionShadowWorkspaceRuntime(base);
    const shadowWorkspace = new ShadowAwareWorkspaceRuntime(base, shadows);
    const runtime = new ShadowAwareToolRuntime(shadowWorkspace);
    runtime.configureShadowWorkspace(shadows);

    const transaction = shadows.workspace('chat-a', 'run-a', 'project-a');
    await transaction.createFile('project-a', 'legacy.txt', 'shadow-only');

    const storage = new MemoryStorage();
    const durable = new DurableOperationJournal(new OperationJournalRuntime(), new OperationJournalStore(storage as unknown as LocalStorage));
    await durable.init();
    runtime.configureIncrementalWorkspaceRuntime(new IncrementalWorkspaceMutationRuntime(base, durable));

    const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('create', 'create_file', { path: 'legacy.txt', content: 'real' }), 'run-a');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /execução legada isolada/i);
    assert.equal(await base.exists('project-a', 'legacy.txt'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('write_file is blocked when the same path has legacy Shadow Workspace changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-agent-core-write-shadow-'));
  try {
    await fs.writeFile(path.join(root, 'conflict.txt'), 'base', 'utf8');
    const base = new WorkspaceRuntime(async () => [{
      id: 'project-a',
      name: 'Project A',
      rootPath: root,
      createdAt: 1,
      updatedAt: 1,
    }]);
    const shadows = new ExecutionShadowWorkspaceRuntime(base);
    const shadowWorkspace = new ShadowAwareWorkspaceRuntime(base, shadows);
    const runtime = new ShadowAwareToolRuntime(shadowWorkspace);
    runtime.configureShadowWorkspace(shadows);
    const transaction = shadows.workspace('chat-a', 'run-a', 'project-a');
    await transaction.writeFile('project-a', 'conflict.txt', 'shadow');

    const storage = new MemoryStorage();
    const durable = new DurableOperationJournal(new OperationJournalRuntime(), new OperationJournalStore(storage as unknown as LocalStorage));
    await durable.init();
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${content}`,
      getText: async (ref: string) => ref.slice('blob:test:'.length),
    };
    runtime.configureIncrementalWorkspaceRuntime(new IncrementalWorkspaceMutationRuntime(base, durable, rollbackBlobs));

    const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('write', 'write_file', { path: 'conflict.txt', content: 'real' }), 'run-a');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /execução legada isolada/i);
    assert.equal(await base.readFile('project-a', 'conflict.txt'), 'base');
    assert.equal(durable.list().length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('replace_range and insert tools materialize directly through the incremental write pipeline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-agent-core-local-edits-'));
  try {
    await fs.writeFile(path.join(root, 'lines.txt'), 'one\ntwo\nthree\n', 'utf8');
    const base = new WorkspaceRuntime(async () => [{
      id: 'project-a',
      name: 'Project A',
      rootPath: root,
      createdAt: 1,
      updatedAt: 1,
    }]);
    const shadows = new ExecutionShadowWorkspaceRuntime(base);
    const runtime = new ShadowAwareToolRuntime(new ShadowAwareWorkspaceRuntime(base, shadows));
    runtime.configureShadowWorkspace(shadows);

    const storage = new MemoryStorage();
    const durable = new DurableOperationJournal(new OperationJournalRuntime(), new OperationJournalStore(storage as unknown as LocalStorage));
    await durable.init();
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`,
      getText: async (ref: string) => Buffer.from(ref.slice('blob:test:'.length), 'base64').toString('utf8'),
    };
    runtime.configureIncrementalWorkspaceRuntime(new IncrementalWorkspaceMutationRuntime(base, durable, rollbackBlobs));

    const replaceRange = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('range', 'replace_range', { path: 'lines.txt', startLine: 2, endLine: 2, content: 'TWO' }), 'run-a');
    assert.equal(replaceRange.ok, true);
    const insertBefore = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('before', 'insert_before', { path: 'lines.txt', line: 2, content: 'before' }), 'run-a');
    assert.equal(insertBefore.ok, true);
    const insertAfter = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('after', 'insert_after', { path: 'lines.txt', line: 1, content: 'after' }), 'run-a');
    assert.equal(insertAfter.ok, true);

    assert.equal(await base.readFile('project-a', 'lines.txt'), 'one\nafter\nbefore\nTWO\nthree\n');
    assert.equal(shadows.get('chat-a', 'run-a'), undefined);
    assert.equal(durable.list({ runId: 'run-a' }).length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
