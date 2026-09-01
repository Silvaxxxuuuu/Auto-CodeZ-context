import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolActivitySnapshot, toActivityInput } from '../src/agent/tool-activity-bridge';
import type { AIToolResult, CommandResultSummary, GitOperationSummary } from '../src/ai/types';

const commandResult: CommandResultSummary = {
  command: 'npm test',
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  timedOut: false,
  startedAt: 100,
  finishedAt: 150,
  durationMs: 50,
};

const gitResult: GitOperationSummary = {
  operation: 'commit',
  branch: 'feature/test',
  output: '[feature/test abc123] test',
};

test('preserva resultado estruturado de comando em atividade', () => {
  const result: AIToolResult = { toolCallId: 'tool-1', ok: true, output: 'ok', commandResult };
  const snapshot = createToolActivitySnapshot('tool-1', 'run_command', result);
  const input = toActivityInput(snapshot);

  assert.equal(input.type, 'test');
  assert.equal(input.status, 'success');
  assert.equal(input.toolCallId, 'tool-1');
  assert.deepEqual(input.commandResult, commandResult);
});

test('preserva resultado estruturado de Git em atividade', () => {
  const result: AIToolResult = { toolCallId: 'tool-2', ok: true, output: gitResult.output, gitResult };
  const snapshot = createToolActivitySnapshot('tool-2', 'git_commit', result);
  const input = toActivityInput(snapshot);

  assert.equal(input.type, 'action');
  assert.equal(input.status, 'success');
  assert.deepEqual(input.gitResult, gitResult);
});

test('marca aprovação pendente sem perder o resultado associado', () => {
  const result: AIToolResult = { toolCallId: 'tool-3', ok: false, error: 'Aprovação necessária.', approvalId: 'approval-1', pendingApproval: true, gitResult };
  const snapshot = createToolActivitySnapshot('tool-3', 'git_commit', result);
  const input = toActivityInput(snapshot);

  assert.equal(input.status, 'pending');
  assert.equal(input.message, 'Aguardando aprovação: git_commit');
  assert.deepEqual(input.gitResult, gitResult);
});
