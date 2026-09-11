import assert from 'node:assert/strict';
import test from 'node:test';
import { DiffRuntime } from '../src/agent/diff-runtime';
import { compactShadowWorkspaceChanges } from '../src/shadow-workspace-publication';

const diffs = new DiffRuntime();

test('múltiplas edições do mesmo arquivo viram um único diff líquido', () => {
  const changes = [
    diffs.create('a.txt', 'modified', 'one\n', 'two\n'),
    diffs.create('a.txt', 'modified', 'two\n', 'three\n'),
  ];

  const compacted = compactShadowWorkspaceChanges(changes);

  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].type, 'modified');
  assert.equal(compacted[0].before, 'one\n');
  assert.equal(compacted[0].after, 'three\n');
});

test('rename é compactado como delete e create com paths únicos', () => {
  const changes = [
    diffs.create('b.txt', 'renamed', 'old\n', 'old\n', 'a.txt'),
    diffs.create('b.txt', 'modified', 'old\n', 'new\n'),
  ];

  const compacted = compactShadowWorkspaceChanges(changes);

  assert.deepEqual(compacted.map((change) => [change.path, change.type]), [
    ['a.txt', 'deleted'],
    ['b.txt', 'created'],
  ]);
  assert.equal(compacted[0].before, 'old\n');
  assert.equal(compacted[1].after, 'new\n');
});

test('arquivo criado e removido na mesma transação não produz publicação líquida', () => {
  const changes = [
    diffs.create('temp.txt', 'created', '', 'temporary\n'),
    diffs.create('temp.txt', 'deleted', 'temporary\n', ''),
  ];

  assert.deepEqual(compactShadowWorkspaceChanges(changes), []);
});

test('delete seguido de create no mesmo path vira modificação líquida', () => {
  const changes = [
    diffs.create('a.txt', 'deleted', 'old\n', ''),
    diffs.create('a.txt', 'created', '', 'new\n'),
  ];

  const compacted = compactShadowWorkspaceChanges(changes);

  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].type, 'modified');
  assert.equal(compacted[0].before, 'old\n');
  assert.equal(compacted[0].after, 'new\n');
});

test('cadeia de renames mantém somente origem inicial e destino final', () => {
  const changes = [
    diffs.create('b.txt', 'renamed', 'content\n', 'content\n', 'a.txt'),
    diffs.create('c.txt', 'renamed', 'content\n', 'content\n', 'b.txt'),
  ];

  const compacted = compactShadowWorkspaceChanges(changes);

  assert.deepEqual(compacted.map((change) => [change.path, change.type]), [
    ['a.txt', 'deleted'],
    ['c.txt', 'created'],
  ]);
});

test('sequência inconsistente falha fechado', () => {
  const changes = [
    diffs.create('a.txt', 'modified', 'one\n', 'two\n'),
    diffs.create('a.txt', 'modified', 'unexpected\n', 'three\n'),
  ];

  assert.throws(() => compactShadowWorkspaceChanges(changes), /sequência inconsistente/i);
});
