import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';

function beforeMissing() {
  return { exists: false } as const;
}

function afterFile(hash = 'sha256-after') {
  return { exists: true, hash, size: 42, modifiedAt: 1100 } as const;
}

test('Operation Journal follows prepare -> executing -> verified and isolates returned objects', () => {
  let now = 1000;
  const runtime = new OperationJournalRuntime({ now: () => now, createId: () => 'op-a' });
  const prepared = runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'src/App.tsx',
    before: beforeMissing(),
    rollbackRef: 'blob:before-a',
  });
  assert.equal(prepared.status, 'prepared');

  now = 1050;
  assert.equal(runtime.start('op-a').status, 'executing');
  now = 1100;
  const verified = runtime.verify('op-a', afterFile());
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verifiedAt, 1100);
  assert.equal(verified.after?.hash, 'sha256-after');

  verified.after!.hash = 'mutated-outside';
  assert.equal(runtime.get('op-a')?.after?.hash, 'sha256-after');
});

test('Operation Journal rejects invalid transitions and duplicate ids', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'same-op' });
  runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'a.txt',
    before: beforeMissing(),
  });
  assert.throws(() => runtime.prepare({
    operationId: 'same-op',
    runId: 'run-b',
    toolCallId: 'tool-b',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'b.txt',
    before: beforeMissing(),
  }), /duplicado/i);
  assert.throws(() => runtime.verify('same-op', afterFile()), /Transição inválida/);
});

test('verified operations can roll back only with rollback evidence', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-a' });
  runtime.prepare({
    runId: 'run-a',
    toolCallId: 'tool-a',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'a.txt',
    before: beforeMissing(),
  });
  runtime.start('op-a');
  runtime.verify('op-a', afterFile());
  assert.throws(() => runtime.markRolledBack('op-a', beforeMissing()), /rollbackRef/);

  const withRollback = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-b' });
  withRollback.prepare({
    runId: 'run-a',
    toolCallId: 'tool-b',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'b.txt',
    before: beforeMissing(),
    rollbackRef: 'blob:b-before',
  });
  withRollback.start('op-b');
  withRollback.verify('op-b', afterFile('b-after'));
  const rolledBack = withRollback.markRolledBack('op-b', beforeMissing());
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.after?.exists, false);
});

test('failed operations preserve error and may record rollback conflicts', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'op-fail' });
  runtime.prepare({
    runId: 'run-fail',
    toolCallId: 'tool-fail',
    capabilityId: 'workspace.write_file',
    projectId: 'project-a',
    target: 'src/a.ts',
    before: { exists: true, hash: 'before' },
    rollbackRef: 'blob:before',
  });
  runtime.start('op-fail');
  const failed = runtime.fail('op-fail', 'rename atômico falhou', { exists: true, hash: 'partial' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'rename atômico falhou');
  const conflict = runtime.markRollbackConflict('op-fail', 'arquivo foi alterado externamente', { exists: true, hash: 'external' });
  assert.equal(conflict.status, 'rollback_conflict');
  assert.equal(conflict.error, 'arquivo foi alterado externamente');
});

test('hydrate is atomic for duplicate records and emits cloned snapshots', () => {
  const runtime = new OperationJournalRuntime({ now: () => 1000, createId: () => 'seed' });
  runtime.prepare({
    runId: 'run-seed',
    toolCallId: 'tool-seed',
    capabilityId: 'workspace.create_file',
    projectId: 'project-a',
    target: 'seed.txt',
    before: beforeMissing(),
  });
  const seed = runtime.get('seed')!;

  assert.throws(() => runtime.hydrate([seed, { ...seed }]), /duplicado/i);
  assert.equal(runtime.get('seed')?.target, 'seed.txt');

  let observed = '';
  runtime.subscribe((records) => {
    if (records[0]) {
      observed = records[0].target;
      records[0].target = 'mutated-listener';
    }
  });
  runtime.start('seed');
  assert.equal(observed, 'seed.txt');
  assert.equal(runtime.get('seed')?.target, 'seed.txt');
});
