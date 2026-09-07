import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { CommandRuntime, type CommandResult, type CommandRunOptions } from '../src/agent/command-runtime';
import type { ProjectRecord } from '../src/ai/types';

class AbortingCommandRuntime extends CommandRuntime {
  constructor(projects: () => Promise<ProjectRecord[]>) {
    super(projects);
  }

  override async run(_projectId: string, _command: string, _options: CommandRunOptions = {}): Promise<CommandResult> {
    const error = new Error('Operação cancelada.');
    error.name = 'AbortError';
    throw error;
  }
}

test('approved command cancellation propagates AbortError and leaves approval recoverable until orchestration cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-tool-abort-'));
  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Cancellation Test',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    const projects = async () => [project];
    const runtime = new ToolRuntime(new WorkspaceRuntime(projects), undefined, undefined, undefined, new AbortingCommandRuntime(projects));
    const pending = await runtime.execute('chat-test', project.id, 'ask', {
      id: 'command-call',
      name: 'run_command',
      input: { command: 'node -e "setTimeout(() => {}, 30000)"' },
    }, 'run-test');

    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);

    await assert.rejects(
      runtime.approve(pending.approvalId),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );

    const approvals = runtime.listApprovals({ chatId: 'chat-test', runId: 'run-test' });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.id, pending.approvalId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run_command definition reserves direct workspace file mutations for diff-backed file tools', () => {
  const runtime = new ToolRuntime(new WorkspaceRuntime(async () => []));
  const definition = runtime.listDefinitions().find((item) => item.name === 'run_command');

  assert.ok(definition);
  assert.match(definition.description, /Do not use it to create, edit, delete or rename workspace files/i);
  assert.match(definition.description, /diff review/i);
});
