import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { IncrementalWorkspaceMutationRuntime } from '../src/agent-core/incremental-workspace-runtime';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';
import { DurableOperationJournal, OperationJournalStore } from '../src/agent-core/operation-journal-store';
import type { LocalStorage } from '../src/core/storage';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  failWrites = false;

  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (this.failWrites) throw new Error('durable journal unavailable');
    this.values.set(name, structuredClone(value));
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-incremental-workspace-'));
  const project: ProjectRecord = {
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const storage = new MemoryStorage();
  let id = 0;
  const journalRuntime = new OperationJournalRuntime({ now: () => 1000 + id, createId: () => `op-${++id}` });
  const journalStore = new OperationJournalStore(storage as unknown as LocalStorage);
  const journal = new DurableOperationJournal(journalRuntime, journalStore);
  await journal.init();
  const incremental = new IncrementalWorkspaceMutationRuntime(workspace, journal);
  return {
    root,
    workspace,
    storage,
    journal,
    incremental,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

const context = { runId: 'run-a', toolCallId: 'tool-a', projectId: 'project-a' };

test('incremental create_file materializes file immediately and journals every created parent directory', async () => {
  const f = await fixture();
  try {
    const result = await f.incremental.createFile(context, 'site/src/index.html', '<h1>Auto CodeZ</h1>');
    assert.equal(await f.workspace.readFile('project-a', 'site/src/index.html'), '<h1>Auto CodeZ</h1>');
    assert.deepEqual(result.createdDirectories, ['site', 'site/src']);
    assert.equal(result.hash.length, 64);

    const record = f.journal.get(result.operationId);
    assert.equal(record?.status, 'verified');
    assert.deepEqual(record?.resources.map((resource) => resource.target), ['site', 'site/src', 'site/src/index.html']);
    assert.equal(record?.resources.every((resource) => resource.after?.exists), true);
  } finally {
    await f.cleanup();
  }
});

test('incremental create_folder is idempotent and only journals real mutations', async () => {
  const f = await fixture();
  try {
    const first = await f.incremental.createFolder(context, 'assets/uploads');
    const second = await f.incremental.createFolder({ ...context, toolCallId: 'tool-b' }, 'assets/uploads');
    assert.equal(first.created, true);
    assert.deepEqual(first.createdDirectories, ['assets', 'assets/uploads']);
    assert.equal(second.created, false);
    assert.equal(second.operationId, undefined);
    assert.equal(f.journal.list().length, 1);
  } finally {
    await f.cleanup();
  }
});

test('durable PREPARED journal failure prevents create_file from touching the real workspace', async () => {
  const f = await fixture();
  try {
    f.storage.failWrites = true;
    await assert.rejects(
      f.incremental.createFile(context, 'blocked/file.txt', 'never-written'),
      /durable journal unavailable/,
    );
    assert.deepEqual(await f.workspace.statPath('project-a', 'blocked/file.txt'), { exists: false });
    assert.deepEqual(await f.workspace.statPath('project-a', 'blocked'), { exists: false });
  } finally {
    await f.cleanup();
  }
});

test('incremental create_file refuses existing destination before opening a journal operation', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'existing.txt', 'before');
    await assert.rejects(
      f.incremental.createFile(context, 'existing.txt', 'after'),
      /já existe/i,
    );
    assert.equal(await f.workspace.readFile('project-a', 'existing.txt'), 'before');
    assert.equal(f.journal.list().length, 0);
  } finally {
    await f.cleanup();
  }
});


test('incremental write_file snapshots previous content before replacing the real file', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'src/app.ts', 'const value = 1;');
    const blobs = new Map<string, string>();
    const rollbackBlobs = {
      putText: async (content: string) => {
        const ref = `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`;
        blobs.set(ref, content);
        return ref;
      },
      getText: async (ref: string) => {
        const content = blobs.get(ref);
        if (content === undefined) throw new Error('missing blob');
        return content;
      },
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, rollbackBlobs);
    const result = await incremental.writeFile(context, 'src/app.ts', 'const value = 2;');

    assert.equal(await f.workspace.readFile('project-a', 'src/app.ts'), 'const value = 2;');
    assert.equal(result.before, 'const value = 1;');
    assert.equal(result.after, 'const value = 2;');
    assert.equal(await rollbackBlobs.getText(result.rollbackRef), 'const value = 1;');

    const record = f.journal.get(result.operationId);
    assert.equal(record?.status, 'verified');
    assert.equal(record?.capabilityId, 'workspace.write_file');
    assert.equal(record?.resources[0].before.contentRef, result.rollbackRef);
    assert.equal(record?.resources[0].rollbackRef, result.rollbackRef);
    assert.equal(record?.resources[0].after?.hash, result.afterHash);
  } finally {
    await f.cleanup();
  }
});

test('incremental write_file requires rollback storage before touching the workspace', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'protected.txt', 'before');
    await assert.rejects(
      f.incremental.writeFile(context, 'protected.txt', 'after'),
      /RollbackBlobStore não foi configurado/,
    );
    assert.equal(await f.workspace.readFile('project-a', 'protected.txt'), 'before');
    assert.equal(f.journal.list().length, 0);
  } finally {
    await f.cleanup();
  }
});


test('incremental write_file refuses stale expected content before journaling or mutation', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'stale.txt', 'current');
    const blobs = {
      putText: async (content: string) => `blob:test:${content}`,
      getText: async (ref: string) => ref.slice('blob:test:'.length),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, blobs);
    await assert.rejects(
      incremental.writeFile(context, 'stale.txt', 'next', 'older'),
      /mudou antes da escrita incremental/i,
    );
    assert.equal(await f.workspace.readFile('project-a', 'stale.txt'), 'current');
    assert.equal(f.journal.list().length, 0);
  } finally {
    await f.cleanup();
  }
});
