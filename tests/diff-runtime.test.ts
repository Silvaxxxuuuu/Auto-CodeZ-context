import assert from 'node:assert/strict';
import test from 'node:test';
import { DiffRuntime } from '../src/agent/diff-runtime';

test('creates an exact line diff and summary', () => {
  const runtime = new DiffRuntime();
  const change = runtime.create('src/example.ts', 'modified', 'one\ntwo\nthree', 'one\nupdated\nthree\nfour');
  assert.equal(change.addedLines, 2);
  assert.equal(change.removedLines, 1);
  const plan = runtime.createPlan([change], '00000000-0000-4000-8000-000000000001');
  assert.equal(plan.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(plan.summary.files, 1);
  assert.equal(plan.summary.modified, 1);
  assert.equal(plan.summary.addedLines, 2);
  assert.equal(plan.summary.removedLines, 1);
});

test('supports created, deleted, and renamed changes', () => {
  const runtime = new DiffRuntime();
  const changes = [runtime.create('new.ts', 'created', '', 'new file'), runtime.create('old.ts', 'deleted', 'old file', ''), runtime.create('new-name.ts', 'renamed', 'same content', 'same content', 'old-name.ts')];
  const plan = runtime.createPlan(changes, '00000000-0000-4000-8000-000000000002');
  assert.deepEqual(plan.summary, { files: 3, created: 1, modified: 0, deleted: 1, renamed: 1, addedLines: 1, removedLines: 1 });
});

test('rejects duplicate paths and malformed rename metadata', () => {
  const runtime = new DiffRuntime();
  const change = runtime.create('src/a.ts', 'modified', 'a', 'b');
  assert.throws(() => runtime.createPlan([change, change]), /alterações duplicadas/);
  assert.throws(() => runtime.create('src/a.ts', 'renamed', 'a', 'b'), /caminho original/);
  assert.throws(() => runtime.create('src/a.ts', 'modified', 'a', 'b', 'old.ts'), /Somente alterações renomeadas/);
});

test('rejects invalid line counts supplied to plans', () => {
  const runtime = new DiffRuntime();
  assert.throws(() => runtime.createPlan([{ path: 'src/a.ts', type: 'modified', before: 'a', after: 'b', addedLines: -1, removedLines: 1 }]), /Contagem de linhas inválida/);
});
