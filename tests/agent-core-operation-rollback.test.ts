import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationJournalRecord } from '../src/agent-core/contracts';
import { OperationRollbackRuntime } from '../src/agent-core/operation-rollback-runtime';

function record(capabilityId: string, status: OperationJournalRecord['status'] = 'verified'): OperationJournalRecord {
  return {
    contractVersion: 1,
    operationId: 'op-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId,
    projectId: 'project-a',
    target: 'src/a.ts',
    resources: [{ target: 'src/a.ts', before: { exists: false, kind: 'file' }, rollbackRef: 'ref-a' }],
    status,
    createdAt: 1,
    updatedAt: 2,
    ...(status === 'verified' ? { verifiedAt: 2 } : {}),
  };
}

function fixture(capabilityId: string, status: OperationJournalRecord['status'] = 'verified') {
  let current = record(capabilityId, status);
  const calls: string[] = [];
  const journal = {
    get: (id: string) => id === 'op-a' ? structuredClone(current) : undefined,
  };
  const mutations = {
    rollbackCreatedFile: async () => { calls.push('create_file'); current = { ...current, status: 'rolled_back', updatedAt: 3 }; },
    rollbackCreatedFolder: async () => { calls.push('create_folder'); current = { ...current, status: 'rolled_back', updatedAt: 3 }; },
    restoreWrittenFile: async () => { calls.push('write_file'); current = { ...current, status: 'rolled_back', updatedAt: 3 }; },
    restoreDeletedFile: async () => { calls.push('delete_file'); current = { ...current, status: 'rolled_back', updatedAt: 3 }; },
    restoreRenamedFile: async () => { calls.push('rename_file'); current = { ...current, status: 'rolled_back', updatedAt: 3 }; },
  };
  const runtime = new OperationRollbackRuntime(journal as never, mutations as never);
  return { runtime, calls };
}

test('unified rollback dispatches every supported workspace capability to one V2 path', async () => {
  const expected = new Map([
    ['workspace.create_file', 'create_file'],
    ['workspace.create_folder', 'create_folder'],
    ['workspace.write_file', 'write_file'],
    ['workspace.delete_file', 'delete_file'],
    ['workspace.rename_file', 'rename_file'],
  ]);
  for (const [capabilityId, call] of expected) {
    const f = fixture(capabilityId);
    const result = await f.runtime.rollback('op-a');
    assert.deepEqual(f.calls, [call]);
    assert.equal(result.operation.status, 'rolled_back');
    assert.equal(result.alreadyRolledBack, false);
  }
});

test('unified rollback is idempotent after confirmed rolled_back state', async () => {
  const f = fixture('workspace.write_file', 'rolled_back');
  const result = await f.runtime.rollback('op-a');
  assert.equal(result.alreadyRolledBack, true);
  assert.deepEqual(f.calls, []);
});

test('unified rollback fails closed for conflicts, non-verified states and unsupported capabilities', async () => {
  await assert.rejects(() => fixture('workspace.write_file', 'rollback_conflict').runtime.rollback('op-a'), /conflito/i);
  await assert.rejects(() => fixture('workspace.write_file', 'executing').runtime.rollback('op-a'), /não está pronta/i);
  await assert.rejects(() => fixture('command.run').runtime.rollback('op-a'), /não suportado/i);
});
