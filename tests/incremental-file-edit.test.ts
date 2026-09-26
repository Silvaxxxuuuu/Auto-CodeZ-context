import assert from 'node:assert/strict';
import test from 'node:test';
import { applyIncrementalEdit } from '../src/agent/incremental-file-edit';

test('replace_range replaces an inclusive 1-based line range', () => {
  const result = applyIncrementalEdit('replace_range', { startLine: 2, endLine: 3, content: 'TWO\nTHREE' }, 'one\ntwo\nthree\nfour\n');
  assert.equal(result, 'one\nTWO\nTHREE\nfour\n');
});

test('replace_text replaces one exact unique anchor', () => {
  const result = applyIncrementalEdit('replace_text', { oldText: 'const enabled = false;', newText: 'const enabled = true;' }, 'const name = "Auto CodeZ";\nconst enabled = false;\n');
  assert.equal(result, 'const name = "Auto CodeZ";\nconst enabled = true;\n');
});

test('replace_text rejects missing and ambiguous anchors', () => {
  assert.throws(() => applyIncrementalEdit('replace_text', { oldText: 'missing', newText: 'x' }, 'alpha\nbeta\n'), /não foi encontrado/);
  assert.throws(() => applyIncrementalEdit('replace_text', { oldText: 'same', newText: 'x' }, 'same\nother\nsame\n'), /ambíguo: 2 ocorrências/);
});

test('insert_before inserts content before the requested line', () => {
  const result = applyIncrementalEdit('insert_before', { line: 2, content: 'inserted' }, 'one\ntwo\nthree');
  assert.equal(result, 'one\ninserted\ntwo\nthree');
});

test('insert_after inserts content after the requested line', () => {
  const result = applyIncrementalEdit('insert_after', { line: 2, content: 'inserted-a\ninserted-b' }, 'one\ntwo\nthree\n');
  assert.equal(result, 'one\ntwo\ninserted-a\ninserted-b\nthree\n');
});

test('incremental edits preserve CRLF and trailing newline style', () => {
  const result = applyIncrementalEdit('replace_range', { startLine: 2, endLine: 2, content: 'B' }, 'a\r\nb\r\nc\r\n');
  assert.equal(result, 'a\r\nB\r\nc\r\n');
  assert.equal(result.includes('\na\n'), false);
});

test('incremental edits reject invalid and out-of-range lines', () => {
  assert.throws(() => applyIncrementalEdit('replace_range', { startLine: 3, endLine: 2, content: 'x' }, 'a\nb\nc'), /startLine não pode ser maior/);
  assert.throws(() => applyIncrementalEdit('insert_before', { line: 0, content: 'x' }, 'a\nb'), /inteiro maior ou igual a 1/);
  assert.throws(() => applyIncrementalEdit('insert_after', { line: 3, content: 'x' }, 'a\nb'), /excede o número de linhas/);
});
