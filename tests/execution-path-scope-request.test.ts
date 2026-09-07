import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOptionalExecutionAllowedPaths } from '../src/execution-path-scope-request';

test('allowedPaths ausente preserva execução sem escopo inicial', () => {
  assert.equal(normalizeOptionalExecutionAllowedPaths(undefined), undefined);
});

test('allowedPaths inicial é normalizado, aparado e deduplicado', () => {
  assert.deepEqual(
    normalizeOptionalExecutionAllowedPaths([' src ', 'tests', 'src']),
    ['src', 'tests'],
  );
});

test('allowedPaths inicial vazio ou inválido falha fechado', () => {
  assert.throws(() => normalizeOptionalExecutionAllowedPaths([]), /Caminhos permitidos inválidos/i);
  assert.throws(() => normalizeOptionalExecutionAllowedPaths(['src', '  ']), /Caminho permitido inválido/i);
  assert.throws(() => normalizeOptionalExecutionAllowedPaths(['src', 42]), /Caminho permitido inválido/i);
});
