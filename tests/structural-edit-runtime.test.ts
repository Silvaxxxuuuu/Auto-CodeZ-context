import assert from 'node:assert/strict';
import test from 'node:test';
import { StructuralEditRuntime, type StructuralSymbolLocator, type StructuralSymbolMatch } from '../src/agent/structural-edit-runtime';

function locator(matches: StructuralSymbolMatch[], supported = true): StructuralSymbolLocator {
  return {
    id: 'test-locator',
    supports: () => supported,
    locate: () => matches.map((match) => ({ ...match })),
  };
}

test('structural edit replaces exactly one parser-provided symbol range', async () => {
  const content = 'before\nfunction greet() { return 1; }\nafter\n';
  const startOffset = content.indexOf('function greet');
  const endOffset = content.indexOf('\nafter');
  const runtime = new StructuralEditRuntime([locator([{ name: 'greet', kind: 'function', startOffset, endOffset, startLine: 2, endLine: 2 }])]);

  const result = await runtime.replaceSymbol('src/example.ts', content, { name: 'greet', kind: 'function' }, 'function greet() { return 2; }');

  assert.equal(result.locatorId, 'test-locator');
  assert.equal(result.before, content);
  assert.equal(result.after, 'before\nfunction greet() { return 2; }\nafter\n');
  assert.deepEqual(result.match, { name: 'greet', kind: 'function', startOffset, endOffset, startLine: 2, endLine: 2 });
});

test('structural edit fails closed when no locator supports the file', async () => {
  const runtime = new StructuralEditRuntime([locator([], false)]);
  await assert.rejects(() => runtime.replaceSymbol('src/example.xyz', 'value', { name: 'value' }, 'next'), /Nenhum localizador estrutural suporta/);
});

test('structural edit rejects missing and ambiguous symbols', async () => {
  const missing = new StructuralEditRuntime([locator([])]);
  await assert.rejects(() => missing.replaceSymbol('src/example.ts', 'const a = 1;', { name: 'a' }, 'const a = 2;'), /não foi encontrado/);

  const ambiguous = new StructuralEditRuntime([locator([
    { name: 'a', kind: 'variable', startOffset: 0, endOffset: 5 },
    { name: 'a', kind: 'variable', startOffset: 6, endOffset: 11 },
  ])]);
  await assert.rejects(() => ambiguous.replaceSymbol('src/example.ts', 'aaaaa aaaaa', { name: 'a' }, 'next'), /ambíguo: 2 correspondências/);
});

test('structural edit rejects invalid parser ranges and mismatched symbol identity', async () => {
  const invalidRange = new StructuralEditRuntime([locator([{ name: 'a', kind: 'variable', startOffset: 0, endOffset: 999 }])]);
  await assert.rejects(() => invalidRange.replaceSymbol('src/example.ts', 'const a = 1;', { name: 'a' }, 'const a = 2;'), /intervalo de símbolo inválido/);

  const wrongName = new StructuralEditRuntime([locator([{ name: 'b', kind: 'variable', startOffset: 0, endOffset: 5 }])]);
  await assert.rejects(() => wrongName.replaceSymbol('src/example.ts', 'aaaaa', { name: 'a' }, 'bbbbb'), /quando 'a' foi solicitado/);

  const wrongKind = new StructuralEditRuntime([locator([{ name: 'a', kind: 'method', startOffset: 0, endOffset: 5 }])]);
  await assert.rejects(() => wrongKind.replaceSymbol('src/example.ts', 'aaaaa', { name: 'a', kind: 'function' }, 'bbbbb'), /não como 'function'/);
});

test('structural edit rejects no-op replacements', async () => {
  const runtime = new StructuralEditRuntime([locator([{ name: 'a', kind: 'variable', startOffset: 0, endOffset: 5 }])]);
  await assert.rejects(() => runtime.replaceSymbol('src/example.ts', 'aaaaa', { name: 'a' }, 'aaaaa'), /não produziria nenhuma alteração/);
});

test('structural edit exposes locator ids without leaking mutable locator state', () => {
  const runtime = new StructuralEditRuntime([
    { id: 'typescript', supports: () => true, locate: () => [] },
    { id: 'tree-sitter', supports: () => true, locate: () => [] },
  ]);
  const ids = runtime.listLocatorIds();
  assert.deepEqual(ids, ['typescript', 'tree-sitter']);
  ids.push('mutated');
  assert.deepEqual(runtime.listLocatorIds(), ['typescript', 'tree-sitter']);
});
