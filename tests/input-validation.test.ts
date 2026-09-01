import assert from 'node:assert/strict';
import test from 'node:test';
import { requireIdentifier, requireNonEmptyString, requireObject } from '../src/core/input-validation';

test('requireNonEmptyString trims valid input', () => {
  assert.equal(requireNonEmptyString('  value  ', 'Campo'), 'value');
});

test('requireNonEmptyString rejects empty values', () => {
  assert.throws(() => requireNonEmptyString('   ', 'Campo'), /Campo não pode estar vazio/);
  assert.throws(() => requireNonEmptyString(null, 'Campo'), /Campo não pode estar vazio/);
});

test('requireIdentifier rejects control characters and oversized values', () => {
  assert.throws(() => requireIdentifier('abc\u0000def', 'ID'), /ID é inválido/);
  assert.throws(() => requireIdentifier('x'.repeat(257), 'ID'), /ID é inválido/);
});

test('requireObject rejects null, arrays and primitive values', () => {
  assert.deepEqual(requireObject({ value: 1 }, 'Dados'), { value: 1 });
  assert.throws(() => requireObject(null, 'Dados'), /Dados é inválido/);
  assert.throws(() => requireObject([], 'Dados'), /Dados é inválido/);
  assert.throws(() => requireObject('value', 'Dados'), /Dados é inválido/);
});
