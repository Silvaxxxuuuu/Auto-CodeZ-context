import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

async function fixture(): Promise<{ root: string; runtime: ToolRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-structural-tool-'));
  const project: ProjectRecord = { id: 'project-test', name: 'Structural Tool Test', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  return { root, runtime: new ToolRuntime(workspace), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function call(id: string, input: Record<string, unknown>): AIToolCall {
  return { id, name: 'replace_symbol', input };
}

test('read_symbol reads one exact AST declaration in read-only mode without approval', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'read.ts');
    const source = '// header\nexport function greet(name: string) {\n  return `Hi ${name}`;\n}\n\nconst tail = true;\n';
    await fs.writeFile(file, source);

    const result = await value.runtime.execute('chat-a', 'project-test', 'read-only', {
      id: 'structural-read',
      name: 'read_symbol',
      input: { path: 'read.ts', symbol: 'greet', kind: 'function' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.output, 'export function greet(name: string) {\n  return `Hi ${name}`;\n}');
    assert.equal(result.approvalId, undefined);
    assert.equal(result.pendingApproval, undefined);
    assert.equal(await fs.readFile(file, 'utf8'), source);
  } finally { await value.cleanup(); }
});

test('replace_symbol definition exposes a strict AST-backed write schema', async () => {
  const value = await fixture();
  try {
    const definition = value.runtime.listDefinitions().find((item) => item.name === 'replace_symbol');
    assert.ok(definition);
    assert.equal(definition.requiresWriteAccess, true);
    assert.equal(definition.requiresApproval, true);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.deepEqual([...(definition.parameters.required as string[])].sort(), ['content', 'kind', 'path', 'symbol']);
    const properties = definition.parameters.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.kind.enum, ['function', 'method', 'class', 'interface', 'type', 'enum']);
  } finally { await value.cleanup(); }
});

test('replace_symbol previews a real AST diff and applies it only after approval', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'example.ts');
    const before = '// header\nexport function greet(name: string) {\n  return `Hi ${name}`;\n}\n\nconst untouched = true;\n';
    const after = '// header\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n\nconst untouched = true;\n';
    await fs.writeFile(file, before);

    const pending = await value.runtime.execute('chat-a', 'project-test', 'ask', call('structural-1', {
      path: 'example.ts',
      symbol: 'greet',
      kind: 'function',
      content: 'export function greet(name: string) {\n  return `Hello ${name}`;\n}',
    }));

    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    assert.equal(pending.diffPlan?.changes[0]?.before, before);
    assert.equal(pending.diffPlan?.changes[0]?.after, after);
    assert.equal(await fs.readFile(file, 'utf8'), before);

    const result = await value.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, true);
    assert.equal(result.changes?.[0]?.after, after);
    assert.equal(await fs.readFile(file, 'utf8'), after);
  } finally { await value.cleanup(); }
});

test('replace_symbol updates a unique class method without touching its class surroundings', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'service.ts');
    await fs.writeFile(file, 'class Service {\n  before() {}\n  run() { return 1; }\n  after() {}\n}\n');

    const result = await value.runtime.execute('chat-a', 'project-test', 'unrestricted', call('structural-method', {
      path: 'service.ts',
      symbol: 'run',
      kind: 'method',
      content: 'run() { return 2; }',
    }));

    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'class Service {\n  before() {}\n  run() { return 2; }\n  after() {}\n}\n');
  } finally { await value.cleanup(); }
});

test('replace_symbol fails closed for ambiguous symbols and unsupported files', async () => {
  const value = await fixture();
  try {
    const duplicateFile = path.join(value.root, 'duplicate.ts');
    const duplicateContent = 'function same() { return 1; }\nfunction same() { return 2; }\n';
    await fs.writeFile(duplicateFile, duplicateContent);
    const ambiguous = await value.runtime.execute('chat-a', 'project-test', 'unrestricted', call('structural-ambiguous', {
      path: 'duplicate.ts', symbol: 'same', kind: 'function', content: 'function same() { return 3; }',
    }));
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error ?? '', /ambíguo: 2 correspondências/);
    assert.equal(await fs.readFile(duplicateFile, 'utf8'), duplicateContent);

    const unsupportedFile = path.join(value.root, 'example.py');
    const unsupportedContent = 'def greet():\n    return 1\n';
    await fs.writeFile(unsupportedFile, unsupportedContent);
    const unsupported = await value.runtime.execute('chat-a', 'project-test', 'unrestricted', call('structural-unsupported', {
      path: 'example.py', symbol: 'greet', kind: 'function', content: 'def greet():\n    return 2\n',
    }));
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error ?? '', /Nenhum localizador estrutural suporta/);
    assert.equal(await fs.readFile(unsupportedFile, 'utf8'), unsupportedContent);
  } finally { await value.cleanup(); }
});

test('replace_symbol approval fails closed if the file changes after preview', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'stale.ts');
    const before = 'function greet() { return 1; }\n';
    await fs.writeFile(file, before);
    const pending = await value.runtime.execute('chat-a', 'project-test', 'ask', call('structural-stale', {
      path: 'stale.ts', symbol: 'greet', kind: 'function', content: 'function greet() { return 2; }',
    }));
    assert.ok(pending.approvalId);

    const external = 'function greet() { return 99; }\n';
    await fs.writeFile(file, external);
    const result = await value.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /mudou desde a aprovação/);
    assert.equal(await fs.readFile(file, 'utf8'), external);
  } finally { await value.cleanup(); }
});

test('read-only permission blocks replace_symbol without mutating the file', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'readonly.ts');
    const before = 'function greet() { return 1; }\n';
    await fs.writeFile(file, before);
    const result = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('structural-readonly', {
      path: 'readonly.ts', symbol: 'greet', kind: 'function', content: 'function greet() { return 2; }',
    }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /bloqueada pelas permissões/);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally { await value.cleanup(); }
});
