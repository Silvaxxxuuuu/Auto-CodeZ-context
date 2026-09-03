import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager } from '../src/execution-manager';

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
