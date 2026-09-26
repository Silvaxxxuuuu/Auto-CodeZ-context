import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolActivitySnapshot, toActivityInput } from '../src/agent/tool-activity-bridge';
import type { AIToolResult, CommandResultSummary, GitOperationSummary } from '../src/ai/types';

const commandResult: CommandResultSummary = { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, startedAt: 100, finishedAt: 150, durationMs: 50 };
const gitResult: GitOperationSummary = { operation: 'commit', branch: 'feature/test', output: '[feature/test abc123] test' };
const runId = '00000000-0000-4000-8000-000000000010';

test('preserva resultado estruturado de comando em atividade', () => {
  const result: AIToolResult = { toolCallId: 'tool-1', ok: true, output: 'ok', commandResult };
  const snapshot = createToolActivitySnapshot(runId, 'tool-1', 'run_command', result);
  const input = toActivityInput(snapshot);
  assert.equal(input.type, 'test');
  assert.equal(input.status, 'success');
  assert.equal(input.runId, runId);
  assert.equal(input.toolCallId, 'tool-1');
  assert.deepEqual(input.commandResult, commandResult);
});

test('preserva resultado estruturado de Git em atividade', () => {
  const result: AIToolResult = { toolCallId: 'tool-2', ok: true, output: gitResult.output, gitResult };
  const snapshot = createToolActivitySnapshot(runId, 'tool-2', 'git_commit', result);
  const input = toActivityInput(snapshot);
  assert.equal(input.type, 'action');
  assert.equal(input.status, 'success');
  assert.deepEqual(input.gitResult, gitResult);
});

test('marca aprovação pendente sem perder o resultado associado', () => {
  const result: AIToolResult = { toolCallId: 'tool-3', ok: false, error: 'Aprovação necessária.', approvalId: 'approval-1', pendingApproval: true, gitResult };
  const snapshot = createToolActivitySnapshot(runId, 'tool-3', 'git_commit', result);
  const input = toActivityInput(snapshot);
  assert.equal(input.status, 'pending');
  assert.equal(input.message, 'Aguardando sua aprovação.');
  assert.deepEqual(input.gitResult, gitResult);
});


test('preserva somente a provenance estruturada da tool para observabilidade posterior', () => {
  const result: AIToolResult = {
    toolCallId: 'tool-web',
    ok: true,
    output: 'ok',
    sources: [{
      title: 'Example',
      url: 'https://example.com/docs',
      origin: 'autocodez-web',
      retrievedAt: 100,
    }],
  };
  const snapshot = createToolActivitySnapshot(runId, 'tool-web', 'web_search', result);
  const input = toActivityInput(snapshot);
  assert.deepEqual(input.sources, result.sources);
});


test('file mutations are described as prepared until the shadow workspace is published', () => {
  const snapshot = createToolActivitySnapshot('run-shadow', 'call-shadow', 'create_file', {
    toolCallId: 'call-shadow',
    ok: true,
    changes: [{
      path: 'Desktop/GameZone/index.html',
      type: 'created',
      before: '',
      after: '<h1>GameZone</h1>',
      addedLines: 1,
      removedLines: 0,
    }],
  });
  assert.equal(snapshot.message, 'Preparado: Desktop/GameZone/index.html');
});
