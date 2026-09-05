import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager, type ExecutionChange } from '../src/execution-manager';

test('mantém execuções independentes por chat', () => {
  const manager = new ExecutionManager();
  const first = manager.start('chat-a', 1000);
  const second = manager.start('chat-b', 1100);

  assert.equal(first.state, 'running');
  assert.equal(second.state, 'running');
  assert.equal(manager.listActive().length, 2);
  assert.notEqual(first.runId, second.runId);
});

test('preserva o runId autoritativo ao iniciar uma execução recuperada', () => {
  const manager = new ExecutionManager();

  const recovered = manager.start('chat-a', 1000, 'backend-run-123');

  assert.equal(recovered.runId, 'backend-run-123');
  assert.equal(manager.get('chat-a')?.runId, 'backend-run-123');
});

test('preserva o runId autoritativo quando a retomada chega sem snapshot em memória', () => {
  const manager = new ExecutionManager();

  const recovered = manager.update('chat-recovered', { state: 'running', runId: 'persisted-run-456' }, 5000);

  assert.equal(recovered.state, 'running');
  assert.equal(recovered.runId, 'persisted-run-456');
  assert.equal(recovered.startedAt, 5000);
  assert.equal(manager.listActive().length, 1);
});

test('rejeita atualização de uma execução com runId obsoleto', () => {
  const manager = new ExecutionManager();
  manager.start('chat-a', 1000, 'current-run');

  assert.throws(
    () => manager.update('chat-a', { state: 'running', runId: 'stale-run' }, 1200),
    /não corresponde à execução ativa/
  );
  assert.equal(manager.get('chat-a')?.runId, 'current-run');
});

test('não permite duas execuções simultâneas no mesmo chat', () => {
  const manager = new ExecutionManager();
  manager.start('chat-a', 1000);

  assert.throws(() => manager.start('chat-a', 1100), /já possui uma execução ativa/);
});

test('preserva histórico de início e atualiza ferramenta/estado', () => {
  const manager = new ExecutionManager();
  const started = manager.start('chat-a', 1000);
  const waiting = manager.update('chat-a', { state: 'waiting_approval', currentTool: 'write_file' }, 1200);
  const failed = manager.update('chat-a', { state: 'failed', error: 'Sem créditos' }, 1400);

  assert.equal(waiting.runId, started.runId);
  assert.equal(waiting.startedAt, 1000);
  assert.equal(waiting.updatedAt, 1200);
  assert.equal(waiting.currentTool, 'write_file');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'Sem créditos');
  assert.equal(manager.listActive().length, 0);
});

test('recupera uma execução em memória quando uma retomada chega sem snapshot', () => {
  const manager = new ExecutionManager();

  const recovered = manager.update('chat-recovered', { state: 'running' }, 5000);

  assert.equal(recovered.state, 'running');
  assert.equal(recovered.chatId, 'chat-recovered');
  assert.equal(recovered.startedAt, 5000);
  assert.equal(manager.listActive().length, 1);
});

test('não cria uma execução implícita para estados terminais', () => {
  const manager = new ExecutionManager();

  assert.throws(() => manager.update('chat-missing', { state: 'completed' }, 5000), /Nenhuma execução encontrada/);
});

test('permite nova execução após uma execução terminal', () => {
  const manager = new ExecutionManager();
  const first = manager.start('chat-a', 1000);
  manager.update('chat-a', { state: 'completed' }, 2000);
  const second = manager.start('chat-a', 3000);

  assert.notEqual(first.runId, second.runId);
  assert.equal(second.startedAt, 3000);
  assert.equal(manager.get('chat-a')?.state, 'running');
});

test('remove o estado de um chat excluído', () => {
  const manager = new ExecutionManager();
  manager.start('chat-a', 1000);
  manager.remove('chat-a');

  assert.equal(manager.get('chat-a'), undefined);
  assert.deepEqual(manager.list(), []);
});

test('publica snapshots autoritativos para início, atualização e remoção', () => {
  const manager = new ExecutionManager();
  const changes: ExecutionChange[] = [];
  manager.subscribe((change) => changes.push(change));

  manager.start('chat-a', 1000, 'run-a');
  manager.update('chat-a', { state: 'waiting_approval', currentTool: 'write_file', runId: 'run-a' }, 1200);
  manager.remove('chat-a');

  assert.deepEqual(changes, [
    { type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-a', state: 'running', startedAt: 1000, updatedAt: 1000 } },
    { type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-a', state: 'waiting_approval', startedAt: 1000, updatedAt: 1200, currentTool: 'write_file', error: undefined } },
    { type: 'remove', chatId: 'chat-a', runId: 'run-a' },
  ]);
});

test('falha de observer não interrompe transição e unsubscribe encerra notificações', () => {
  const manager = new ExecutionManager();
  const changes: ExecutionChange[] = [];
  manager.subscribe(() => { throw new Error('observer failure'); });
  const unsubscribe = manager.subscribe((change) => changes.push(change));

  const started = manager.start('chat-a', 1000, 'run-a');
  assert.equal(started.state, 'running');
  unsubscribe();
  manager.update('chat-a', { state: 'completed', runId: 'run-a' }, 1200);

  assert.equal(changes.length, 1);
  assert.equal(manager.get('chat-a')?.state, 'completed');
});
