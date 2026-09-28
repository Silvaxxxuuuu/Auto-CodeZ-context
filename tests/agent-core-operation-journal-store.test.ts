import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalStorage } from '../src/core/storage';
import type { OperationJournalRecord } from '../src/agent-core/contracts';
import { OperationJournalPersistence, OperationJournalStore } from '../src/agent-core/operation-journal-store';

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
  return {
    contractVersion: 1,
    operationId: input.operationId ?? 'op-a',
    runId: input.runId ?? 'run-a',
    toolCallId: input.toolCallId ?? 'tool-a',
    capabilityId: input.capabilityId ?? 'workspace.create_file',
    projectId: input.projectId ?? 'project-a',
    target: input.target ?? 'src/a.ts',
    status: input.status ?? 'verified',
    before: input.before ?? { exists: false },
    after: input.after ?? { exists: true, hash: 'after', size: 10 },
    rollbackRef: input.rollbackRef ?? 'blob:before',
    createdAt: input.createdAt ?? 1000,
    updatedAt: input.updatedAt ?? 1100,
    verifiedAt: input.verifiedAt ?? 1100,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

test('Operation Journal store persists valid records and deduplicates by newest update', async () => {
  const storage = new MemoryStorage();
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  await store.save([
    record({ operationId: 'same', updatedAt: 1100, verifiedAt: 1100, target: 'old.ts' }),
    record({ operationId: 'same', updatedAt: 1200, verifiedAt: 1200, target: 'new.ts' }),
  ]);
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].target, 'new.ts');
});

test('Operation Journal store ignores malformed or impossible records', async () => {
  const storage = new MemoryStorage();
  storage.seed('agent-core-operation-journal.json', {
    version: 1,
    records: [
      record({ operationId: 'valid' }),
      { ...record({ operationId: 'bad-time' }), updatedAt: 500 },
      { ...record({ operationId: 'bad-verified' }), after: undefined },
      { ...record({ operationId: 'bad-failed', status: 'failed', verifiedAt: undefined }), error: undefined },
    ],
  });
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  assert.deepEqual((await store.load()).map((item) => item.operationId), ['valid']);
});

test('Operation Journal persistence serializes saves and reports durable write failure', async () => {
  const storage = new MemoryStorage();
  const store = new OperationJournalStore(storage as unknown as LocalStorage);
  const persistence = new OperationJournalPersistence(store);
  persistence.schedule([record({ operationId: 'first' })]);
  persistence.schedule([record({ operationId: 'second' })]);
  await persistence.flush();
  assert.deepEqual((await store.load()).map((item) => item.operationId), ['second']);

  storage.failWrites = true;
  persistence.schedule([record({ operationId: 'failed' })]);
  await assert.rejects(() => persistence.flush(), /write failed/);
});
