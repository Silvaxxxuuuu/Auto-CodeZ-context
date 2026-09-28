import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalStorage } from '../src/core/storage';
import type { OperationJournalRecord } from '../src/agent-core/contracts';
import { DurableOperationJournal, OperationJournalStore } from '../src/agent-core/operation-journal-store';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  failWrites = false;

  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (this.failWrites) throw new Error('write failed');
    this.values.set(name, structuredClone(value));
  }

  seed(name: string, value: unknown): void {
    this.values.set(name, structuredClone(value));
  }
}

function record(input: Partial<OperationJournalRecord> = {}): OperationJournalRecord {
  const target = input.target ?? 'src/a.ts';
  return {
    contractVersion: 1,
    operationId: input.operationId ?? 'op-a',
    runId: input.runId ?? 'run-a',
    toolCallId: input.toolCallId ?? 'tool-a',
    capabilityId: input.capabilityId ?? 'workspace.create_file',
    projectId: input.projectId ?? 'project-a',
    target,
    resources: input.resources ?? [{
      target,
      before: { exists: false, kind: 'file' },
      after: { exists: true, kind: 'file', hash: 'after', size: 10 },
      rollbackRef: `delete:${target}`,
    }],
    status: input.status ?? 'verified',
    createdAt: input.createdAt ?? 1000,
    updatedAt: input.updatedAt ?? 1100,
    verifiedAt: input.verifiedAt ?? 1100,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

test('Operation Journal store persists valid multi-resource records and deduplicates by newest update', async () => {
  const storage = new MemoryStorage();
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  await store.save([
    record({ operationId: 'same', updatedAt: 1100, verifiedAt: 1100, target: 'old.ts', resources: [{ target: 'old.ts', before: { exists: false }, after: { exists: true }, rollbackRef: 'delete:old' }] }),
    record({ operationId: 'same', updatedAt: 1200, verifiedAt: 1200, target: 'new.ts', resources: [{ target: 'new.ts', before: { exists: false }, after: { exists: true }, rollbackRef: 'delete:new' }] }),
  ]);
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].target, 'new.ts');
});

test('Operation Journal store ignores malformed resource sets or impossible records', async () => {
  const storage = new MemoryStorage();
  storage.seed('agent-core-operation-journal.json', {
    version: 1,
    records: [
      record({ operationId: 'valid' }),
      { ...record({ operationId: 'bad-time' }), updatedAt: 500 },
      { ...record({ operationId: 'missing-resource' }), resources: [] },
      { ...record({ operationId: 'missing-after' }), resources: [{ target: 'src/a.ts', before: { exists: false } }] },
      { ...record({ operationId: 'bad-failed', status: 'failed', verifiedAt: undefined }), error: undefined },
    ],
  });
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  assert.deepEqual((await store.load()).map((item) => item.operationId), ['valid']);
});

test('Durable Operation Journal reverts in-memory transition when encrypted persistence fails', async () => {
  const storage = new MemoryStorage();
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-durable' });
  const durable = new DurableOperationJournal(runtime, store);
  await durable.init();

  await durable.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'a.txt',
    resources: [{ target: 'a.txt', before: { exists: false }, rollbackRef: 'delete:a.txt' }],
  });
  assert.equal(runtime.get('op-durable')?.status, 'prepared');

  storage.failWrites = true;
  await assert.rejects(() => durable.start('op-durable'), /write failed/);
  assert.equal(runtime.get('op-durable')?.status, 'prepared');

  storage.failWrites = false;
  assert.equal((await durable.start('op-durable')).status, 'executing');
});

test('Durable Operation Journal serializes concurrent state transitions', async () => {
  const storage = new MemoryStorage();
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  let id = 0;
  const runtime = new OperationJournalRuntime({ now: () => 1000 + id, createId: () => `op-${++id}` });
  const durable = new DurableOperationJournal(runtime, store);
  await durable.init();

  const [first, second] = await Promise.all([
    durable.prepare({
      runId: 'run-a',
      toolCallId: 'tool-a',
      capabilityId: 'workspace.create_folder',
      projectId: 'project-a',
      target: 'a',
      resources: [{ target: 'a', before: { exists: false }, rollbackRef: 'remove:a' }],
    }),
    durable.prepare({
      runId: 'run-a',
      toolCallId: 'tool-b',
      capabilityId: 'workspace.create_folder',
      projectId: 'project-a',
      target: 'b',
      resources: [{ target: 'b', before: { exists: false }, rollbackRef: 'remove:b' }],
    }),
  ]);
  assert.notEqual(first.operationId, second.operationId);
  assert.equal((await store.load()).length, 2);
});
