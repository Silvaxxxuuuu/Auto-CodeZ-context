import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { CommandRuntime } from '../src/agent/command-runtime';
import { ExecutionChangeBudgetRuntime } from '../src/execution-change-budget';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

async function fixture(): Promise<{ root: string; runtime: ToolRuntime; budget: ExecutionChangeBudgetRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-budget-tool-'));
  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Budget Tool Project',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const commands = new CommandRuntime(async () => [project]);
  const runtime = new ToolRuntime(workspace, undefined, undefined, undefined, commands);
  const budget = new ExecutionChangeBudgetRuntime();
  runtime.configureExecutionChangeBudget(budget);
  return { root, runtime, budget, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('sem Change Budget configurado preserva execução irrestrita', async () => {
  const current = await fixture();
  try {
    await fs.writeFile(path.join(current.root, 'notes.txt'), 'before');
    const result = await current.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      call('call-a', 'write_file', { path: 'notes.txt', content: 'after' }),
      'run-a',
    );
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(path.join(current.root, 'notes.txt'), 'utf8'), 'after');
  } finally {
    await current.cleanup();
  }
});

test('bloqueia mutação irrestrita antes de ultrapassar linhas permitidas', async () => {
  const current = await fixture();
  try {
    await fs.writeFile(path.join(current.root, 'notes.txt'), 'one\ntwo\n');
    current.runtime.configureChangeBudget('chat-a', 'run-a', { maxChangedLines: 1 });

    const result = await current.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      call('call-a', 'write_file', { path: 'notes.txt', content: 'alpha\nbeta\n' }),
      'run-a',
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Change Budget excedido/i);
    assert.equal(await fs.readFile(path.join(current.root, 'notes.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(current.runtime.getChangeBudgetUsage('chat-a', 'run-a').changedLines, 0);
  } finally {
    await current.cleanup();
  }
});

test('não cria aprovação quando o diff projetado já excede o budget', async () => {
  const current = await fixture();
  try {
    await fs.writeFile(path.join(current.root, 'notes.txt'), 'before');
    current.runtime.configureChangeBudget('chat-a', 'run-a', { maxFiles: 0 });

    const result = await current.runtime.execute(
      'chat-a',
      'project-test',
      'ask',
      call('call-a', 'write_file', { path: 'notes.txt', content: 'after' }),
      'run-a',
    );

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Change Budget excedido/i);
    assert.equal(result.pendingApproval, undefined);
    assert.equal(current.runtime.listApprovals().length, 0);
    assert.equal(await fs.readFile(path.join(current.root, 'notes.txt'), 'utf8'), 'before');
  } finally {
    await current.cleanup();
  }
});

test('revalida o budget na aprovação depois que outro uso consumiu o limite', async () => {
  const current = await fixture();
  try {
    await fs.writeFile(path.join(current.root, 'a.txt'), 'before-a');
    await fs.writeFile(path.join(current.root, 'b.txt'), 'before-b');
    current.runtime.configureChangeBudget('chat-a', 'run-a', { maxFiles: 1, maxToolCalls: 10 });

    const pending = await current.runtime.execute(
      'chat-a',
      'project-test',
      'ask',
      call('pending', 'write_file', { path: 'a.txt', content: 'after-a' }),
      'run-a',
    );
    assert.ok(pending.approvalId);

    current.budget.record('chat-a', 'run-a', {
      toolName: 'write_file',
      changes: [{ path: 'b.txt', type: 'modified', before: 'before-b', after: 'after-b', addedLines: 1, removedLines: 1 }],
    });

    const result = await current.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Change Budget excedido/i);
    assert.equal(await fs.readFile(path.join(current.root, 'a.txt'), 'utf8'), 'before-a');
  } finally {
    await current.cleanup();
  }
});

test('registra consumo somente depois de ferramenta bem-sucedida', async () => {
  const current = await fixture();
  try {
    current.runtime.configureChangeBudget('chat-a', 'run-a', { maxCommands: 2, maxToolCalls: 2 });

    const failed = await current.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      call('failed', 'read_file', { path: 'missing.txt' }),
      'run-a',
    );
    assert.equal(failed.ok, false);
    assert.equal(current.runtime.getChangeBudgetUsage('chat-a', 'run-a').toolCalls, 0);

    const command = await current.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      call('command', 'run_command', { command: 'node -e "process.exit(0)"' }),
      'run-a',
    );
    assert.equal(command.ok, true);
    const usage = current.runtime.getChangeBudgetUsage('chat-a', 'run-a');
    assert.equal(usage.commands, 1);
    assert.equal(usage.toolCalls, 1);
  } finally {
    await current.cleanup();
  }
});
