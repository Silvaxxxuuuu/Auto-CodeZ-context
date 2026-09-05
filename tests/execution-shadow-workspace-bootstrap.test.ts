import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShadowWorkspaceSnapshot } from '../src/agent/shadow-workspace';
import { reconcileShadowWorkspaceBootstrap } from '../src/execution-shadow-workspace-bootstrap';

function snapshot(chatId: string, runId: string, updatedAt: number): ShadowWorkspaceSnapshot {
  return {
    chatId,
    runId,
    projectId: 'project-a',
    createdAt: 100,
    updatedAt,
    status: 'active',
    changes: [{
      path: `${runId}.txt`,
      type: 'created',
      before: '',
      after: runId,
      addedLines: 1,
      removedLines: 0,
    }],
  };
}

test('bootstrap preserva somente shadows ligados a runs pendentes ou recuperáveis', () => {
  const result = reconcileShadowWorkspaceBootstrap(
    [snapshot('chat-a', 'run-pending', 110), snapshot('chat-b', 'run-recoverable', 120), snapshot('chat-c', 'run-orphan', 130)],
    [{ chatId: 'chat-a', runId: 'run-pending' }],
    [{ chatId: 'chat-b', runId: 'run-recoverable' }],
  );

  assert.deepEqual(result.map((item) => item.runId), ['run-recoverable', 'run-pending']);
});

test('bootstrap deduplica a mesma run escolhendo o snapshot mais recente', () => {
  const older = snapshot('chat-a', 'run-a', 110);
  const newer = snapshot('chat-a', 'run-a', 130);
  newer.changes[0].after = 'newer';

  const result = reconcileShadowWorkspaceBootstrap(
    [older, newer],
    [],
    [{ chatId: 'chat-a', runId: 'run-a' }],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].updatedAt, 130);
  assert.equal(result[0].changes[0].after, 'newer');
});

test('bootstrap não confunde runId igual em chats diferentes', () => {
  const result = reconcileShadowWorkspaceBootstrap(
    [snapshot('chat-a', 'same-run', 110), snapshot('chat-b', 'same-run', 120)],
    [],
    [{ chatId: 'chat-b', runId: 'same-run' }],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].chatId, 'chat-b');
});

test('bootstrap devolve cópias defensivas', () => {
  const original = snapshot('chat-a', 'run-a', 110);
  const result = reconcileShadowWorkspaceBootstrap(
    [original],
    [{ chatId: 'chat-a', runId: 'run-a' }],
    [],
  );

  result[0].changes[0].after = 'tampered';
  assert.equal(original.changes[0].after, 'run-a');
});

test('bootstrap rejeita contêineres inválidos', () => {
  assert.throws(
    () => reconcileShadowWorkspaceBootstrap(null as never, [], []),
    /bootstrap do Shadow Workspace inválido/i,
  );
});
