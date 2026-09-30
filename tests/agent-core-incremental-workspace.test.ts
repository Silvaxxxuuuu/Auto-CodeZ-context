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


test('incremental delete_file snapshots content, removes the real file and can restore it exactly', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'remove-me.txt', 'important before state');
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
    const result = await incremental.deleteFile(context, 'remove-me.txt', 'important before state');

    assert.deepEqual(await f.workspace.statPath('project-a', 'remove-me.txt'), { exists: false });
    const deleted = f.journal.get(result.operationId);
    assert.equal(deleted?.status, 'verified');
    assert.equal(deleted?.capabilityId, 'workspace.delete_file');
    assert.equal(deleted?.resources[0].before.contentRef, result.rollbackRef);
    assert.equal(deleted?.resources[0].after?.exists, false);
    assert.equal(await rollbackBlobs.getText(result.rollbackRef), 'important before state');

    await incremental.restoreDeletedFile(result.operationId);
    assert.equal(await f.workspace.readFile('project-a', 'remove-me.txt'), 'important before state');
    assert.equal(f.journal.get(result.operationId)?.status, 'rolled_back');
  } finally {
    await f.cleanup();
  }
});

test('incremental delete_file rejects stale content before journaling or deleting', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'stale-delete.txt', 'current');
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${content}`,
      getText: async (ref: string) => ref.slice('blob:test:'.length),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, rollbackBlobs);
    await assert.rejects(
      incremental.deleteFile(context, 'stale-delete.txt', 'older'),
      /mudou antes da exclusão incremental/i,
    );
    assert.equal(await f.workspace.readFile('project-a', 'stale-delete.txt'), 'current');
    assert.equal(f.journal.list().length, 0);
  } finally {
    await f.cleanup();
  }
});

test('delete rollback fails closed when the deleted path was recreated externally', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'conflict-delete.txt', 'before');
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`,
      getText: async (ref: string) => Buffer.from(ref.slice('blob:test:'.length), 'base64').toString('utf8'),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, rollbackBlobs);
    const result = await incremental.deleteFile(context, 'conflict-delete.txt', 'before');
    await f.workspace.createFile('project-a', 'conflict-delete.txt', 'external');

    await assert.rejects(() => incremental.restoreDeletedFile(result.operationId), /recriado.*rollback bloqueado/i);
    assert.equal(await f.workspace.readFile('project-a', 'conflict-delete.txt'), 'external');
    assert.equal(f.journal.get(result.operationId)?.status, 'rollback_conflict');
  } finally {
    await f.cleanup();
  }
});


test('incremental rename_file journals source, destination and created parents then rolls back exactly', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'source.txt', 'rename-state');
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`,
      getText: async (ref: string) => Buffer.from(ref.slice('blob:test:'.length), 'base64').toString('utf8'),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, rollbackBlobs);
    const result = await incremental.renameFile(context, 'source.txt', 'nested/deeper/destination.txt', 'rename-state');

    assert.deepEqual(await f.workspace.statPath('project-a', 'source.txt'), { exists: false });
    assert.equal(await f.workspace.readFile('project-a', 'nested/deeper/destination.txt'), 'rename-state');
    assert.deepEqual(result.createdDirectories, ['nested', 'nested/deeper']);

    const record = f.journal.get(result.operationId);
    assert.equal(record?.status, 'verified');
    assert.equal(record?.capabilityId, 'workspace.rename_file');
    assert.deepEqual(record?.resources.map((resource) => resource.target), ['nested', 'nested/deeper', 'source.txt', 'nested/deeper/destination.txt']);

    await incremental.restoreRenamedFile(result.operationId);
    assert.equal(await f.workspace.readFile('project-a', 'source.txt'), 'rename-state');
    assert.deepEqual(await f.workspace.statPath('project-a', 'nested/deeper/destination.txt'), { exists: false });
    assert.deepEqual(await f.workspace.statPath('project-a', 'nested'), { exists: false });
    assert.equal(f.journal.get(result.operationId)?.status, 'rolled_back');
  } finally {
    await f.cleanup();
  }
});

test('rename rollback fails closed when destination content changed externally', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'source.txt', 'before');
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`,
      getText: async (ref: string) => Buffer.from(ref.slice('blob:test:'.length), 'base64').toString('utf8'),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, rollbackBlobs);
    const result = await incremental.renameFile(context, 'source.txt', 'destination.txt', 'before');
    await f.workspace.writeFile('project-a', 'destination.txt', 'external');

    await assert.rejects(() => incremental.restoreRenamedFile(result.operationId), /destino.*mudou.*rollback bloqueado/i);
    assert.deepEqual(await f.workspace.statPath('project-a', 'source.txt'), { exists: false });
    assert.equal(await f.workspace.readFile('project-a', 'destination.txt'), 'external');
    assert.equal(f.journal.get(result.operationId)?.status, 'rollback_conflict');
  } finally {
    await f.cleanup();
  }
});

test('rename rollback refuses destination directories containing external entries before moving anything back', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFile('project-a', 'source.txt', 'before');
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`,
      getText: async (ref: string) => Buffer.from(ref.slice('blob:test:'.length), 'base64').toString('utf8'),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(f.workspace, f.journal, rollbackBlobs);
    const result = await incremental.renameFile(context, 'source.txt', 'created/destination.txt', 'before');
    await f.workspace.createFile('project-a', 'created/external.txt', 'external');

    await assert.rejects(() => incremental.restoreRenamedFile(result.operationId), /pasta 'created'.*mudou.*rollback bloqueado/i);
    assert.deepEqual(await f.workspace.statPath('project-a', 'source.txt'), { exists: false });
    assert.equal(await f.workspace.readFile('project-a', 'created/destination.txt'), 'before');
    assert.equal(await f.workspace.readFile('project-a', 'created/external.txt'), 'external');
    assert.equal(f.journal.get(result.operationId)?.status, 'rollback_conflict');
  } finally {
    await f.cleanup();
  }
});


test('create_file rollback removes only resources created by the operation and preserves existing parents', async () => {
  const f = await fixture();
  try {
    await f.workspace.createFolder('project-a', 'existing');
    const result = await f.incremental.createFile(context, 'existing/generated/deep/file.txt', 'generated');
    await f.incremental.rollbackCreatedFile(result.operationId);

    assert.deepEqual(await f.workspace.statPath('project-a', 'existing/generated/deep/file.txt'), { exists: false });
    assert.deepEqual(await f.workspace.statPath('project-a', 'existing/generated/deep'), { exists: false });
    assert.deepEqual(await f.workspace.statPath('project-a', 'existing/generated'), { exists: false });
    assert.equal((await f.workspace.statPath('project-a', 'existing')).kind, 'directory');
    assert.equal(f.journal.get(result.operationId)?.status, 'rolled_back');
  } finally {
    await f.cleanup();
  }
});

test('create_file rollback fails closed when the created file changed externally', async () => {
  const f = await fixture();
  try {
    const result = await f.incremental.createFile(context, 'generated/file.txt', 'created');
    await f.workspace.writeFile('project-a', 'generated/file.txt', 'external change');

    await assert.rejects(() => f.incremental.rollbackCreatedFile(result.operationId), /mudou.*rollback bloqueado/i);
    assert.equal(await f.workspace.readFile('project-a', 'generated/file.txt'), 'external change');
    assert.equal(f.journal.get(result.operationId)?.status, 'rollback_conflict');
  } finally {
    await f.cleanup();
  }
});

test('create_folder rollback removes the created directory chain but blocks external children', async () => {
  const clean = await fixture();
  try {
    const result = await clean.incremental.createFolder(context, 'assets/generated/deep');
    assert.ok(result.operationId);
    await clean.incremental.rollbackCreatedFolder(result.operationId as string);
    assert.deepEqual(await clean.workspace.statPath('project-a', 'assets'), { exists: false });
    assert.equal(clean.journal.get(result.operationId as string)?.status, 'rolled_back');
  } finally {
    await clean.cleanup();
  }

  const conflict = await fixture();
  try {
    const result = await conflict.incremental.createFolder(context, 'assets/generated');
    assert.ok(result.operationId);
    await conflict.workspace.createFile('project-a', 'assets/generated/external.txt', 'external');
    await assert.rejects(
      () => conflict.incremental.rollbackCreatedFolder(result.operationId as string),
      /conteúdo externo.*rollback bloqueado/i,
    );
    assert.equal(await conflict.workspace.readFile('project-a', 'assets/generated/external.txt'), 'external');
    assert.equal(conflict.journal.get(result.operationId as string)?.status, 'rollback_conflict');
  } finally {
    await conflict.cleanup();
  }
});

test('write_file rollback restores encrypted previous content and blocks stale current state', async () => {
  const success = await fixture();
  try {
    await success.workspace.createFile('project-a', 'src/app.ts', 'before');
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
    const incremental = new IncrementalWorkspaceMutationRuntime(success.workspace, success.journal, rollbackBlobs);
    const result = await incremental.writeFile(context, 'src/app.ts', 'after', 'before');
    await incremental.restoreWrittenFile(result.operationId);
    assert.equal(await success.workspace.readFile('project-a', 'src/app.ts'), 'before');
    assert.equal(success.journal.get(result.operationId)?.status, 'rolled_back');
  } finally {
    await success.cleanup();
  }

  const conflict = await fixture();
  try {
    await conflict.workspace.createFile('project-a', 'src/app.ts', 'before');
    const rollbackBlobs = {
      putText: async (content: string) => `blob:test:${Buffer.from(content, 'utf8').toString('base64')}`,
      getText: async (ref: string) => Buffer.from(ref.slice('blob:test:'.length), 'base64').toString('utf8'),
    };
    const incremental = new IncrementalWorkspaceMutationRuntime(conflict.workspace, conflict.journal, rollbackBlobs);
    const result = await incremental.writeFile(context, 'src/app.ts', 'after', 'before');
    await conflict.workspace.writeFile('project-a', 'src/app.ts', 'external');
    await assert.rejects(() => incremental.restoreWrittenFile(result.operationId), /mudou.*rollback bloqueado/i);
    assert.equal(await conflict.workspace.readFile('project-a', 'src/app.ts'), 'external');
    assert.equal(conflict.journal.get(result.operationId)?.status, 'rollback_conflict');
  } finally {
    await conflict.cleanup();
  }
});
