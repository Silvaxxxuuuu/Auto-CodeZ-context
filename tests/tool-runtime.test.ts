import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { CommandRuntime } from '../src/agent/command-runtime';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

async function createToolRuntime(commandRuntime?: CommandRuntime): Promise<{ root: string; runtime: ToolRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-tool-test-'));
  const project: ProjectRecord = { id: 'project-test', name: 'Tool Test Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const commands = commandRuntime ?? new CommandRuntime(async () => [project]);
  return { root, runtime: new ToolRuntime(workspace, undefined, undefined, undefined, commands), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall { return { id, name, input }; }
const CHAT_ID = 'chat-test';

test('listDefinitions returns independent definition objects', async () => {
  const fixture = await createToolRuntime();
  try {
    const first = fixture.runtime.listDefinitions();
    const second = fixture.runtime.listDefinitions();
    assert.notEqual(first, second);
    assert.notEqual(first[0], second[0]);
    assert.equal(first.some((definition) => definition.name === 'read_file'), true);
    assert.equal(first.some((definition) => definition.name === 'run_command'), true);
  } finally { await fixture.cleanup(); }
});

test('all tool schemas require every declared property for strict provider compatibility', async () => {
  const fixture = await createToolRuntime();
  try {
    for (const definition of fixture.runtime.listDefinitions()) {
      const properties = definition.parameters.properties;
      assert.ok(properties && typeof properties === 'object');
      const propertyNames = Object.keys(properties as Record<string, unknown>);
      const required = Array.isArray(definition.parameters.required) ? definition.parameters.required : [];
      assert.deepEqual([...required].sort(), [...propertyNames].sort(), definition.name);
      assert.equal(definition.parameters.additionalProperties, false, definition.name);
    }
  } finally { await fixture.cleanup(); }
});

test('read_file executes without approval and returns file contents', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'src', 'index.ts'), 'export const value = 42;');
    const result = await fixture.runtime.execute(CHAT_ID, 'project-test', 'ask', call('call-1', 'read_file', { path: 'src/index.ts' }));
    assert.equal(result.ok, true);
    assert.equal(result.output, 'export const value = 42;');
    assert.equal(result.pendingApproval, undefined);
  } finally { await fixture.cleanup(); }
});

test('write_file creates a diff-backed approval without modifying the file', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const result = await fixture.runtime.execute(CHAT_ID, 'project-test', 'ask', call('call-2', 'write_file', { path: 'notes.txt', content: 'after' }));
    assert.equal(result.ok, false);
    assert.equal(result.pendingApproval, true);
    assert.ok(result.approvalId);
    assert.ok(result.diffPlan);
    assert.equal(result.diffPlan?.changes[0]?.before, 'before');
    assert.equal(result.diffPlan?.changes[0]?.after, 'after');
    assert.equal(result.diffPlan?.summary.modified, 1);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'before');
    assert.equal(fixture.runtime.listApprovals()[0]?.diffPlan?.id, result.diffPlan?.id);
    assert.equal(fixture.runtime.listApprovals()[0]?.chatId, CHAT_ID);
  } finally { await fixture.cleanup(); }
});

test('approving a write_file executes the approved plan and returns the resulting diff', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const pending = await fixture.runtime.execute(CHAT_ID, 'project-test', 'ask', call('call-3', 'write_file', { path: 'notes.txt', content: 'after' }));
    assert.ok(pending.approvalId);
    const result = await fixture.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, true);
    assert.equal(result.changes?.[0]?.before, 'before');
    assert.equal(result.changes?.[0]?.after, 'after');
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'after');
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally { await fixture.cleanup(); }
});

test('approval refuses execution when the workspace changed after preview', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const pending = await fixture.runtime.execute(CHAT_ID, 'project-test', 'ask', call('call-4', 'write_file', { path: 'notes.txt', content: 'after' }));
    assert.ok(pending.approvalId);
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'changed externally');
    const result = await fixture.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /mudou desde a aprovação/);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'changed externally');
  } finally { await fixture.cleanup(); }
});

test('approving the same approval twice fails without executing twice', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const pending = await fixture.runtime.execute(CHAT_ID, 'project-test', 'ask', call('call-5', 'write_file', { path: 'notes.txt', content: 'after' }));
    assert.ok(pending.approvalId);
    await fixture.runtime.approve(pending.approvalId!);
    await assert.rejects(fixture.runtime.approve(pending.approvalId!), /Aprovação não encontrada/);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'after');
  } finally { await fixture.cleanup(); }
});

test('invalid tool input is rejected before permission or execution', async () => {
  const fixture = await createToolRuntime();
  try {
    const result = await fixture.runtime.execute(CHAT_ID, 'project-test', 'unrestricted', call('call-6', 'read_file', { path: 'src/index.ts', unexpected: true }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Parâmetro não permitido/);
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally { await fixture.cleanup(); }
});

test('read-only permission denies write tools', async () => {
  const fixture = await createToolRuntime();
  try {
    const result = await fixture.runtime.execute(CHAT_ID, 'project-test', 'read-only', call('call-7', 'write_file', { path: 'notes.txt', content: 'blocked' }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /bloqueada pelas permissões/);
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally { await fixture.cleanup(); }
});

test('run_command fails closed when no command runtime is configured', async () => {
  const fixture = await createToolRuntime();
  try {
    const workspaceOnly = new ToolRuntime(new WorkspaceRuntime(async () => [{ id: 'project-test', name: 'Tool Test Project', rootPath: fixture.root, createdAt: Date.now(), updatedAt: Date.now() }]));
    const pending = await workspaceOnly.execute(CHAT_ID, 'project-test', 'ask', call('call-8', 'run_command', { manager: 'npm', script: 'test' }));
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    assert.equal(pending.diffPlan, undefined);
    const result = await workspaceOnly.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /runtime de comandos não foi configurado/i);
  } finally { await fixture.cleanup(); }
});

test('run_command returns a structured command result', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.stdout.write('command-result-ok')\"" } }));
    const pending = await fixture.runtime.execute(CHAT_ID, 'project-test', 'ask', call('call-9', 'run_command', { manager: 'npm', script: 'test' }));
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    const result = await fixture.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, true);
    assert.equal(result.commandResult?.exitCode, 0);
    assert.match(result.commandResult?.stdout ?? '', /command-result-ok/);
    assert.ok((result.commandResult?.durationMs ?? -1) >= 0);
    assert.ok((result.commandResult?.finishedAt ?? 0) >= (result.commandResult?.startedAt ?? 1));
    assert.equal(result.commandResult?.command, 'npm run test');
  } finally { await fixture.cleanup(); }
});
