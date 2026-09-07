import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRollbackCheckpoint } from '../src/execution-checkpoint-recovery';

function checkpoint(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: input.id ?? 'checkpoint-a',
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    projectId: input.projectId ?? 'project-a',
    toolCallId: input.toolCallId ?? 'tool-a',
    createdAt: input.createdAt ?? 1000,
    status: input.status ?? 'ready',
    changes: input.changes ?? [{ path: 'src/a.ts', type: 'modified', addedLines: 1, removedLines: 1 }],
  };
}

test('seleciona o checkpoint ready mais recente da mesma execução com falha', () => {
  const selected = selectRollbackCheckpoint(
    { chatId: 'chat-a', runId: 'run-a', state: 'failed' },
    [
      checkpoint({ id: 'older', createdAt: 1000 }),
      checkpoint({ id: 'newer', createdAt: 2000 }),
      checkpoint({ id: 'other-run', runId: 'run-b', createdAt: 3000 }),
    ],
  );

  assert.equal(selected?.id, 'newer');
});

test('após restaurar o checkpoint mais recente, seleciona o anterior ainda pronto', () => {
  const selected = selectRollbackCheckpoint(
    { chatId: 'chat-a', runId: 'run-a', state: 'failed' },
    [
      checkpoint({ id: 'older-ready', createdAt: 1000 }),
      checkpoint({ id: 'newer-restored', createdAt: 2000, status: 'restored' }),
    ],
  );

  assert.equal(selected?.id, 'older-ready');
});

test('aceita execução interrompida e rejeita estados ativos ou concluídos', () => {
  const values = [checkpoint()];
  assert.equal(selectRollbackCheckpoint({ chatId: 'chat-a', runId: 'run-a', state: 'interrupted' }, values)?.id, 'checkpoint-a');
  assert.equal(selectRollbackCheckpoint({ chatId: 'chat-a', runId: 'run-a', state: 'running' }, values), undefined);
  assert.equal(selectRollbackCheckpoint({ chatId: 'chat-a', runId: 'run-a', state: 'waiting_approval' }, values), undefined);
  assert.equal(selectRollbackCheckpoint({ chatId: 'chat-a', runId: 'run-a', state: 'completed' }, values), undefined);
});

test('ignora checkpoint restaurado, sem alterações ou de outro escopo', () => {
  const execution = { chatId: 'chat-a', runId: 'run-a', state: 'failed' };
  assert.equal(selectRollbackCheckpoint(execution, [checkpoint({ status: 'restored' })]), undefined);
  assert.equal(selectRollbackCheckpoint(execution, [checkpoint({ changes: [] })]), undefined);
  assert.equal(selectRollbackCheckpoint(execution, [checkpoint({ chatId: 'chat-b' })]), undefined);
  assert.equal(selectRollbackCheckpoint(execution, [checkpoint({ runId: 'run-b' })]), undefined);
});

test('ignora payloads malformados sem lançar', () => {
  assert.equal(selectRollbackCheckpoint(null, []), undefined);
  assert.equal(selectRollbackCheckpoint({ chatId: '', runId: 'run-a', state: 'failed' }, []), undefined);
  assert.equal(selectRollbackCheckpoint({ chatId: 'chat-a', runId: 'run-a', state: 'failed' }, null), undefined);
  assert.equal(selectRollbackCheckpoint(
    { chatId: 'chat-a', runId: 'run-a', state: 'failed' },
    [checkpoint({ changes: [{ path: '', type: 'modified', addedLines: 1, removedLines: 1 }] })],
  ), undefined);
});
