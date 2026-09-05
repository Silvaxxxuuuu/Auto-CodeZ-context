import assert from 'node:assert/strict';
import test from 'node:test';
import { StructuralEditRuntime } from '../src/agent/structural-edit-runtime';
import { TypeScriptStructuralLocator } from '../src/agent/typescript-structural-locator';

test('TypeScript locator supports TS and JS family files only', () => {
  const locator = new TypeScriptStructuralLocator();
  for (const file of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts']) assert.equal(locator.supports(file), true, file);
  for (const file of ['a.py', 'a.java', 'a.json', 'a.css']) assert.equal(locator.supports(file), false, file);
});

test('TypeScript locator finds exported async functions with exact syntax range', () => {
  const content = '// keep this comment\nexport async function loadData() {\n  return 1;\n}\nconst tail = true;\n';
  const locator = new TypeScriptStructuralLocator();
  const matches = locator.locate('src/example.ts', content, { name: 'loadData', kind: 'function' });

  assert.equal(matches.length, 1);
  const match = matches[0];
  assert.equal(match.kind, 'function');
  assert.equal(match.startLine, 2);
  assert.equal(match.endLine, 4);
  assert.equal(content.slice(match.startOffset, match.endOffset), 'export async function loadData() {\n  return 1;\n}');
});

test('TypeScript locator finds classes, interfaces, type aliases and enums', () => {
  const content = [
    'interface User { id: string }',
    'type UserId = string;',
    'enum State { Ready, Done }',
    'class Service {}',
  ].join('\n');
  const locator = new TypeScriptStructuralLocator();

  assert.equal(locator.locate('types.ts', content, { name: 'User', kind: 'interface' })[0]?.kind, 'interface');
  assert.equal(locator.locate('types.ts', content, { name: 'UserId', kind: 'type' })[0]?.kind, 'type');
  assert.equal(locator.locate('types.ts', content, { name: 'State', kind: 'enum' })[0]?.kind, 'enum');
  assert.equal(locator.locate('types.ts', content, { name: 'Service', kind: 'class' })[0]?.kind, 'class');
});

test('TypeScript locator finds nested class methods but ignores computed method names', () => {
  const content = 'class Service {\n  run() { return 1; }\n  ["computed"]() { return 2; }\n}\n';
  const locator = new TypeScriptStructuralLocator();
  const run = locator.locate('service.ts', content, { name: 'run', kind: 'method' });
  const computed = locator.locate('service.ts', content, { name: 'computed', kind: 'method' });

  assert.equal(run.length, 1);
  assert.equal(content.slice(run[0].startOffset, run[0].endOffset), 'run() { return 1; }');
  assert.equal(computed.length, 0);
});

test('TypeScript locator filters by kind and preserves ambiguity for duplicate symbols', () => {
  const content = 'function duplicate() {}\nclass Box { duplicate() {} }\nfunction duplicate() {}\n';
  const locator = new TypeScriptStructuralLocator();

  assert.equal(locator.locate('example.ts', content, { name: 'duplicate', kind: 'function' }).length, 2);
  assert.equal(locator.locate('example.ts', content, { name: 'duplicate', kind: 'method' }).length, 1);
  assert.equal(locator.locate('example.ts', content, { name: 'duplicate' }).length, 3);
});

test('structural runtime rejects ambiguous TypeScript symbols instead of guessing', async () => {
  const content = 'function same() { return 1; }\nfunction same() { return 2; }\n';
  const runtime = new StructuralEditRuntime([new TypeScriptStructuralLocator()]);

  await assert.rejects(
    () => runtime.replaceSymbol('example.ts', content, { name: 'same', kind: 'function' }, 'function same() { return 3; }'),
    /ambíguo: 2 correspondências/,
  );
});

test('structural runtime replaces a real TypeScript AST symbol without touching surrounding text', async () => {
  const content = '// header\nexport function greet(name: string) {\n  return `Hi ${name}`;\n}\n\nconst untouched = true;\n';
  const runtime = new StructuralEditRuntime([new TypeScriptStructuralLocator()]);
  const replacement = 'export function greet(name: string) {\n  return `Hello ${name}`;\n}';
  const result = await runtime.replaceSymbol('src/greet.ts', content, { name: 'greet', kind: 'function' }, replacement);

  assert.equal(result.locatorId, 'typescript');
  assert.equal(result.after, '// header\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n\nconst untouched = true;\n');
});
