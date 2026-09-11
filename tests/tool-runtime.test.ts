import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { CommandRuntime } from '../src/agent/command-runtime';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

async function createToolRuntime(commandRuntime?: CommandRuntime): Promise<{ root: string; runtime: ToolRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-tool-test-'));
  const project: ProjectRecord = { id: 'project-test', name: 'Tool Test Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const commands = commandRuntime ?? new CommandRuntime(async () => [project]);
  return { root, runtime: new ToolRuntime(workspace, undefined, undefined, undefined, commands), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall { return { id, name, input }; }

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
    const result = await fixture.runtime.execute('chat-test', 'project-test', 'ask', call('call-1', 'read_file', { path: 'src/index.ts' }));
    assert.equal(result.ok, true);
    assert.equal(result.output, 'export const value = 42;');
    assert.equal(result.pendingApproval, undefined);
  } finally { await fixture.cleanup(); }
});

test('write_file creates a chat-owned diff-backed approval without modifying the file', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const result = await fixture.runtime.execute('chat-test', 'project-test', 'ask', call('call-2', 'write_file', { path: 'notes.txt', content: 'after' }));
    assert.equal(result.ok, false);
    assert.equal(result.pendingApproval, true);
    assert.ok(result.approvalId);
    assert.ok(result.diffPlan);
    assert.equal(result.diffPlan?.changes[0]?.before, 'before');
    assert.equal(result.diffPlan?.changes[0]?.after, 'after');
    assert.equal(result.diffPlan?.summary.modified, 1);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'before');
    assert.equal(fixture.runtime.listApprovals()[0]?.chatId, 'chat-test');
    assert.equal(fixture.runtime.listApprovals()[0]?.diffPlan?.id, result.diffPlan?.id);
  } finally { await fixture.cleanup(); }
});

test('approvals created by different chats retain independent ownership', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes-a.txt'), 'before-a');
    await fs.writeFile(path.join(fixture.root, 'notes-b.txt'), 'before-b');
    const first = await fixture.runtime.execute('chat-a', 'project-test', 'ask', call('call-a', 'write_file', { path: 'notes-a.txt', content: 'after-a' }));
    const second = await fixture.runtime.execute('chat-b', 'project-test', 'ask', call('call-b', 'write_file', { path: 'notes-b.txt', content: 'after-b' }));
    assert.ok(first.approvalId);
    assert.ok(second.approvalId);
    const approvals = fixture.runtime.listApprovals();
    assert.equal(approvals.length, 2);
    assert.equal(approvals.find((approval) => approval.id === first.approvalId)?.chatId, 'chat-a');
    assert.equal(approvals.find((approval) => approval.id === second.approvalId)?.chatId, 'chat-b');
  } finally { await fixture.cleanup(); }
});

test('activity summaries describe approval and concrete command execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-activity-test-'));
  try {
    const project: ProjectRecord = { id: 'project-test', name: 'Activity Test Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
    const workspace = new WorkspaceRuntime(async () => [project]);
    const activity = new ActivityRuntime();
    const events: Array<{ message: string; status: string }> = [];
    activity.subscribe((event) => events.push({ message: event.message, status: event.status }));
    const commands = new CommandRuntime(async () => [project]);
    const runtime = new ToolRuntime(workspace, undefined, activity, undefined, commands);
    const pending = await runtime.execute('chat-test', 'project-test', 'unrestricted', call('call-activity', 'run_command', { command: 'mkdir activity-test' }));
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    assert.equal(events.some((event) => event.status === 'pending' && /aguardando aprovação/i.test(event.message)), true);

    const result = await runtime.approve(pending.approvalId as string);
    assert.equal(result.ok, true);
    assert.equal(events.some((event) => event.message === 'Executando mkdir activity-test' && event.status === 'running'), true);
    assert.equal(events.some((event) => event.status === 'success' && event.message === 'Concluído: run_command'), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('approving a write_file executes the approved plan and returns the resulting diff', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const pending = await fixture.runtime.execute('chat-test', 'project-test', 'ask', call('call-3', 'write_file', { path: 'notes.txt', content: 'after' }));
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
    const pending = await fixture.runtime.execute('chat-test', 'project-test', 'ask', call('call-4', 'write_file', { path: 'notes.txt', content: 'after' }));
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
    const pending = await fixture.runtime.execute('chat-test', 'project-test', 'ask', call('call-5', 'write_file', { path: 'notes.txt', content: 'after' }));
    assert.ok(pending.approvalId);
    await fixture.runtime.approve(pending.approvalId!);
    await assert.rejects(fixture.runtime.approve(pending.approvalId!), /Aprovação não encontrada/);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'after');
  } finally { await fixture.cleanup(); }
});

test('invalid tool input is rejected before permission or execution', async () => {
  const fixture = await createToolRuntime();
  try {
    const result = await fixture.runtime.execute('chat-test', 'project-test', 'unrestricted', call('call-6', 'read_file', { path: 'src/index.ts', unexpected: true }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Parâmetro não permitido/);
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally { await fixture.cleanup(); }
});

test('read-only permission denies write tools', async () => {
  const fixture = await createToolRuntime();
  try {
    const result = await fixture.runtime.execute('chat-test', 'project-test', 'read-only', call('call-7', 'write_file', { path: 'notes.txt', content: 'blocked' }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /bloqueada pelas permissões/);
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally { await fixture.cleanup(); }
});

test('run_command fails closed when no command runtime is configured', async () => {
  const fixture = await createToolRuntime();
  try {
    const workspaceOnly = new ToolRuntime(new WorkspaceRuntime(async () => [{ id: 'project-test', name: 'Tool Test Project', rootPath: fixture.root, createdAt: Date.now(), updatedAt: Date.now() }]));
    const pending = await workspaceOnly.execute('chat-test', 'project-test', 'ask', call('call-8', 'run_command', { manager: 'npm', script: 'test' }));
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    const result = await workspaceOnly.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /runtime de comandos não foi configurado/i);
  } finally { await fixture.cleanup(); }
});

test('run_command returns a structured command result', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ scripts: { test: "node -e \"process.stdout.write('command-result-ok')\"" } }));
    const pending = await fixture.runtime.execute('chat-test', 'project-test', 'ask', call('call-9', 'run_command', { manager: 'npm', script: 'test' }));
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
