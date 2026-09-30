import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolActivitySnapshot, toActivityInput, toStructuredToolActivity } from '../src/agent/tool-activity-bridge';
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


test('V2 activity adapter preserves verified command timing without changing the legacy transport', () => {
  const result: AIToolResult = { toolCallId: 'command-1', ok: true, output: 'ok', commandResult };
  const snapshot = createToolActivitySnapshot(runId, 'command-1', 'run_command', result);
  const before = toActivityInput(snapshot);
  const mapped = toStructuredToolActivity(snapshot, 1000);
  assert.equal(mapped.contractVersion, 1);
  assert.equal(mapped.phase, 'completed');
  assert.equal(mapped.runId, runId);
  assert.equal(mapped.toolCallId, 'command-1');
  assert.equal(mapped.toolName, 'run_command');
  assert.equal(mapped.capabilityId, 'command.run');
  assert.deepEqual(mapped.subject, { command: 'npm test' });
  assert.equal(mapped.durationMs, 50);
  assert.equal(mapped.createdAt, 1000);
  assert.deepEqual(toActivityInput(snapshot), before);
});

test('V2 activity adapter differentiates pending approvals, failures and verified file changes', () => {
  const pending = toStructuredToolActivity(createToolActivitySnapshot(runId, 'pending-1', 'interact_instance', {
    toolCallId: 'pending-1', ok: false, pendingApproval: true, approvalId: 'approval-1',
  }), 2000);
  assert.equal(pending.phase, 'waiting');
  assert.equal(pending.subject, undefined);
  assert.equal(pending.durationMs, undefined);
  const failed = toStructuredToolActivity(createToolActivitySnapshot(runId, 'failed-1', 'inspect_instance', {
    toolCallId: 'failed-1', ok: false, error: 'Preview fechado.',
  }), 2001);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.subject, undefined);
  const changed = toStructuredToolActivity(createToolActivitySnapshot(runId, 'file-1', 'create_file', {
    toolCallId: 'file-1', ok: true,
    changes: [{ path: 'src/a.ts', type: 'created', before: '', after: 'export {};', addedLines: 1, removedLines: 0 }],
  }), 2002);
  assert.equal(changed.phase, 'completed');
  assert.equal(changed.toolName, 'create_file');
  assert.equal(changed.capabilityId, 'workspace.create_file');
  assert.deepEqual(changed.subject, { path: 'src/a.ts' });
  assert.equal(changed.summary?.includes('src/a.ts'), true);
  assert.equal(changed.id, `tool:${runId}:file-1:completed`);
});
