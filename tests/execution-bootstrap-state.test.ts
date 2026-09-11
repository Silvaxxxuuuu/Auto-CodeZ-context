import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileExecutionBootstrapState } from '../src/execution-bootstrap-state';
import type { ExecutionSnapshot } from '../src/execution-manager';

function snapshot(input: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    state: input.state ?? 'completed',
    startedAt: input.startedAt ?? 1000,
    updatedAt: input.updatedAt ?? 1200,
    ...(input.currentTool !== undefined ? { currentTool: input.currentTool } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

test('preserva snapshots persistidos sem run recuperável correspondente', () => {
  const persisted = [
    snapshot({ chatId: 'chat-complete', runId: 'run-complete', state: 'completed' }),
    snapshot({ chatId: 'chat-failed', runId: 'run-failed', state: 'failed', error: 'x' }),
  ];

  const result = reconcileExecutionBootstrapState({ persisted, pendingRuns: [], recoverableRuns: [], now: 5000 });
  assert.deepEqual(result, persisted);
});

test('reconcilia run recuperável como interrupted preservando timestamps da mesma execução', () => {
  const result = reconcileExecutionBootstrapState({
    persisted: [snapshot({ chatId: 'chat-a', runId: 'run-a', state: 'interrupted', startedAt: 1000, updatedAt: 1800 })],
    pendingRuns: [],
    recoverableRuns: [{ chatId: 'chat-a', runId: 'run-a' }],
    now: 5000,
  });

  assert.deepEqual(result, [{ chatId: 'chat-a', runId: 'run-a', state: 'interrupted', startedAt: 1000, updatedAt: 1800 }]);
});

test('run pendente tem precedência sobre recuperável do mesmo chat', () => {
  const result = reconcileExecutionBootstrapState({
    persisted: [snapshot({ chatId: 'chat-a', runId: 'old-run', state: 'failed', error: 'old' })],
    pendingRuns: [{ chatId: 'chat-a', runId: 'pending-run' }],
    recoverableRuns: [{ chatId: 'chat-a', runId: 'recoverable-run' }],
    now: 5000,
  });

  assert.deepEqual(result, [{ chatId: 'chat-a', runId: 'pending-run', state: 'waiting_approval', startedAt: 5000, updatedAt: 5000 }]);
});

test('novo run de bootstrap não herda timestamps, ferramenta ou erro de execução antiga', () => {
  const result = reconcileExecutionBootstrapState({
    persisted: [snapshot({ chatId: 'chat-a', runId: 'old-run', state: 'failed', startedAt: 1000, updatedAt: 2000, error: 'old' })],
    pendingRuns: [{ chatId: 'chat-a', runId: 'new-run' }],
    recoverableRuns: [],
    now: 7000,
  });

  assert.deepEqual(result, [{ chatId: 'chat-a', runId: 'new-run', state: 'waiting_approval', startedAt: 7000, updatedAt: 7000 }]);
});

test('não compartilha referências com snapshots persistidos', () => {
  const persisted = [snapshot({ chatId: 'chat-a', runId: 'run-a' })];
  const result = reconcileExecutionBootstrapState({ persisted, pendingRuns: [], recoverableRuns: [], now: 5000 });

  result[0].runId = 'mutated';
  assert.equal(persisted[0].runId, 'run-a');
});

test('rejeita data ou coleções inválidas', () => {
  assert.throws(() => reconcileExecutionBootstrapState({ persisted: [], pendingRuns: [], recoverableRuns: [], now: -1 }), /Data de reconciliação inválida/i);
  assert.throws(() => reconcileExecutionBootstrapState({ persisted: [] as ExecutionSnapshot[], pendingRuns: null as never, recoverableRuns: [], now: 0 }), /Estado de bootstrap inválido/i);
});
