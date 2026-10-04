import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';

function beforeMissing(kind: 'file' | 'directory' = 'file') {
  return { exists: false, kind } as const;
}

function afterFile(hash = 'sha256-after') {
  return { exists: true, kind: 'file' as const, hash, size: 42, modifiedAt: 1100 };
}

test('Operation Journal follows prepare -> executing -> verified for multiple affected resources', () => {
  let now = 1000;
  const runtime = new OperationJournalRuntime({ now: () => now, createId: () => 'op-a' });
  const prepared = runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'src/components/App.tsx',
    resources: [
      { target: 'src', before: beforeMissing('directory'), rollbackRef: 'remove-if-empty:src' },
      { target: 'src/components', before: beforeMissing('directory'), rollbackRef: 'remove-if-empty:src/components' },
      { target: 'src/components/App.tsx', before: beforeMissing(), rollbackRef: 'delete-if-unchanged:src/components/App.tsx' },
    ],
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.resources.length, 3);

  now = 1050;
  assert.equal(runtime.start('op-a').status, 'executing');
  now = 1100;
  const verified = runtime.verify('op-a', [
    { target: 'src', after: { exists: true, kind: 'directory' } },
    { target: 'src/components', after: { exists: true, kind: 'directory' } },
    { target: 'src/components/App.tsx', after: afterFile() },
  ]);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verifiedAt, 1100);
  assert.equal(verified.resources[2].after?.hash, 'sha256-after');

  verified.resources[2].after!.hash = 'mutated-outside';
  assert.equal(runtime.get('op-a')?.resources[2].after?.hash, 'sha256-after');
});

test('Operation Journal rejects missing primary resource, duplicates and incomplete verification', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'same-op' });
  assert.throws(() => runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'a.txt',
    resources: [{ target: 'other.txt', before: beforeMissing() }],
  }), /target principal/i);

  runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'a.txt',
    resources: [{ target: 'a.txt', before: beforeMissing(), rollbackRef: 'delete:a.txt' }],
  });
  assert.throws(() => runtime.prepare({
    operationId: 'same-op',
    runId: 'run-b',
    toolCallId: 'tool-b',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'b.txt',
    resources: [{ target: 'b.txt', before: beforeMissing() }],
  }), /duplicado/i);
  runtime.start('same-op');
  assert.throws(() => runtime.verify('same-op', []), /todos os recursos/i);
});

test('rolled back operation requires rollback evidence for every affected resource', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-a' });
  runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'a.txt',
    resources: [{ target: 'a.txt', before: beforeMissing() }],
  });
  runtime.start('op-a');
  runtime.verify('op-a', [{ target: 'a.txt', after: afterFile() }]);
  assert.throws(
    () => runtime.markRolledBack('op-a', [{ target: 'a.txt', after: beforeMissing() }]),
    /rollbackRef/,
  );

  const withRollback = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-b' });
  withRollback.prepare({
    runId: 'run-a',
    toolCallId: 'tool-b',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'b.txt',
    resources: [{ target: 'b.txt', before: beforeMissing(), rollbackRef: 'delete:b.txt' }],
  });
  withRollback.start('op-b');
  withRollback.verify('op-b', [{ target: 'b.txt', after: afterFile('b-after') }]);
  const rolledBack = withRollback.markRolledBack('op-b', [{ target: 'b.txt', after: beforeMissing() }]);
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.resources[0].after?.exists, false);
});

test('failed operations preserve error and partial post-state for recovery', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-fail' });
  runtime.prepare({
    runId: 'run-fail',
    toolCallId: 'tool-fail',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'nested/a.ts',
    resources: [
      { target: 'nested', before: beforeMissing('directory'), rollbackRef: 'remove-if-empty:nested' },
      { target: 'nested/a.ts', before: beforeMissing(), rollbackRef: 'delete:nested/a.ts' },
    ],
  });
  runtime.start('op-fail');
  const failed = runtime.fail('op-fail', 'materialização falhou', [
    { target: 'nested', after: { exists: true, kind: 'directory' } },
  ]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'materialização falhou');
  assert.equal(failed.resources[0].after?.exists, true);
  assert.equal(failed.resources[1].after, undefined);
  const conflict = runtime.markRollbackConflict('op-fail', 'pasta alterada externamente', [
    { target: 'nested', after: { exists: true, kind: 'directory' } },
  ]);
  assert.equal(conflict.status, 'rollback_conflict');
});

test('hydrate is atomic for duplicate records and emits cloned snapshots', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'seed' });
  runtime.prepare({
    runId: 'run-seed',
    toolCallId: 'tool-seed',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'seed.txt',
    resources: [{ target: 'seed.txt', before: beforeMissing() }],
  });
  const seed = runtime.get('seed')!;

  assert.throws(() => runtime.hydrate([seed, { ...seed }]), /duplicado/i);
  assert.equal(runtime.get('seed')?.target, 'seed.txt');

  let observed = '';
  runtime.subscribe((records) => {
    if (records[0]) {
      observed = records[0].target;
      records[0].resources[0].target = 'mutated-listener';
    }
  });
  runtime.start('seed');
  assert.equal(observed, 'seed.txt');
  assert.equal(runtime.get('seed')?.resources[0].target, 'seed.txt');
});
