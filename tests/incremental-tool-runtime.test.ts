import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

async function fixture(): Promise<{ root: string; runtime: ToolRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-incremental-tool-'));
  const project: ProjectRecord = { id: 'project-test', name: 'Incremental Tool Test', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  return { root, runtime: new ToolRuntime(workspace), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('incremental tool definitions are exposed with strict schemas', async () => {
  const value = await fixture();
  try {
    for (const name of ['replace_range', 'insert_before', 'insert_after'] as const) {
      const definition = value.runtime.listDefinitions().find((item) => item.name === name);
      assert.ok(definition, name);
      assert.equal(definition.requiresWriteAccess, true);
      assert.equal(definition.requiresApproval, true);
      const properties = definition.parameters.properties as Record<string, unknown>;
      assert.deepEqual([...(definition.parameters.required as string[])].sort(), Object.keys(properties).sort());
      assert.equal(definition.parameters.additionalProperties, false);
    }
  } finally { await value.cleanup(); }
});

test('replace_range previews an exact diff and applies it only after approval', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'sample.ts');
    await fs.writeFile(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const pending = await value.runtime.execute('chat-a', 'project-test', 'ask', call('replace-1', 'replace_range', {
      path: 'sample.ts', startLine: 2, endLine: 2, content: 'const b = 20;',
    }));

    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    assert.equal(pending.diffPlan?.changes[0]?.before, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    assert.equal(pending.diffPlan?.changes[0]?.after, 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    assert.equal(await fs.readFile(file, 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const result = await value.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, true);
    assert.equal(result.changes?.[0]?.after, 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    assert.equal(await fs.readFile(file, 'utf8'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  } finally { await value.cleanup(); }
});

test('insert_before and insert_after make localized edits in unrestricted mode', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'sample.txt');
    await fs.writeFile(file, 'one\ntwo\nthree\n');

    const before = await value.runtime.execute('chat-a', 'project-test', 'unrestricted', call('insert-1', 'insert_before', {
      path: 'sample.txt', line: 2, content: 'before-two',
    }));
    assert.equal(before.ok, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'one\nbefore-two\ntwo\nthree\n');

    const after = await value.runtime.execute('chat-a', 'project-test', 'unrestricted', call('insert-2', 'insert_after', {
      path: 'sample.txt', line: 3, content: 'after-two',
    }));
    assert.equal(after.ok, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'one\nbefore-two\ntwo\nafter-two\nthree\n');
  } finally { await value.cleanup(); }
});

test('incremental approval fails closed if the file changed after preview', async () => {
  const value = await fixture();
  try {
    const file = path.join(value.root, 'sample.txt');
    await fs.writeFile(file, 'one\ntwo\nthree\n');
    const pending = await value.runtime.execute('chat-a', 'project-test', 'ask', call('replace-stale', 'replace_range', {
      path: 'sample.txt', startLine: 2, endLine: 2, content: 'TWO',
    }));
    assert.ok(pending.approvalId);

    await fs.writeFile(file, 'one\nexternally changed\nthree\n');
    const result = await value.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /mudou desde a aprovação/);
    assert.equal(await fs.readFile(file, 'utf8'), 'one\nexternally changed\nthree\n');
  } finally { await value.cleanup(); }
});

test('read-only permission blocks incremental mutations', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'sample.txt'), 'one\ntwo\n');
    const result = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('replace-readonly', 'replace_range', {
      path: 'sample.txt', startLine: 1, endLine: 1, content: 'ONE',
    }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /bloqueada pelas permissões/);
  } finally { await value.cleanup(); }
});
