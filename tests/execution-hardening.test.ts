import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionCoordinator } from '../src/execution-coordinator';
import { ExecutionManager } from '../src/execution-manager';
import { ExecutionPlanner } from '../src/execution-planner';
import { ExecutionTimeline } from '../src/execution-timeline';

test('rejeita atualização temporalmente obsoleta sem alterar o snapshot autoritativo', () => {
  const manager = new ExecutionManager();
  manager.start('chat-a', 1000, 'run-a');
  manager.update('chat-a', { state: 'waiting_approval', currentTool: 'write_file', runId: 'run-a' }, 1200);

  assert.throws(
    () => manager.update('chat-a', { state: 'running', runId: 'run-a' }, 1100),
    /obsoleta/i,
  );
  assert.equal(manager.get('chat-a')?.state, 'waiting_approval');
  assert.equal(manager.get('chat-a')?.updatedAt, 1200);
});

test('rejeita reabertura de uma run terminal por update', () => {
  const manager = new ExecutionManager();
  manager.start('chat-a', 1000, 'run-a');
  manager.update('chat-a', { state: 'completed', runId: 'run-a' }, 1200);

  assert.throws(
    () => manager.update('chat-a', { state: 'running', runId: 'run-a' }, 1300),
    /transição inválida|estado terminal/i,
  );
  assert.equal(manager.get('chat-a')?.state, 'completed');
});

test('update terminal idempotente não fabrica nova transição', () => {
  const manager = new ExecutionManager();
  const changes: string[] = [];
  manager.subscribe((change) => changes.push(change.type));
  manager.start('chat-a', 1000, 'run-a');
  manager.update('chat-a', { state: 'failed', error: 'falhou', runId: 'run-a' }, 1200);

  const repeated = manager.update('chat-a', { state: 'failed', error: 'falhou', runId: 'run-a' }, 1400);
  assert.equal(repeated.updatedAt, 1200);
  assert.deepEqual(changes, ['upsert', 'upsert']);
});

test('coordinator impede conclusão quando plano declarado ficou incompleto', () => {
  let id = 0;
  const manager = new ExecutionManager();
  const planner = new ExecutionPlanner({ now: () => 1000 + id, createId: () => `id-${++id}` });
  const coordinator = new ExecutionCoordinator(manager, planner);
  manager.start('chat-a', 1000, 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Construir feature', ['Editar arquivos', 'Executar testes']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.recordEvidence('chat-a', 'run-a', { type: 'file', summary: 'Arquivo alterado', reference: 'src/a.ts' });

  const result = coordinator.complete('chat-a', 'run-a');

  assert.equal(result.execution.state, 'failed');
  assert.match(result.error || '', /antes de concluir o plano/i);
  assert.equal(planner.get('chat-a', 'run-a')?.status, 'failed');
  assert.equal(planner.get('chat-a', 'run-a')?.steps[0].status, 'failed');
});

test('coordinator conclui run somente quando o plano inteiro está concluído', () => {
  let id = 0;
  const manager = new ExecutionManager();
  const planner = new ExecutionPlanner({ now: () => 1000 + id, createId: () => `id-${++id}` });
  const coordinator = new ExecutionCoordinator(manager, planner);
  manager.start('chat-a', 1000, 'run-a');
  let plan = planner.create('chat-a', 'run-a', 'Tarefa', ['Executar']);
  plan = planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'result', summary: 'Concluído' }]);

  const result = coordinator.complete('chat-a', 'run-a');

  assert.equal(result.execution.state, 'completed');
  assert.equal(result.error, undefined);
});

test('coordinator restaura passo pendente antes de retomar uma execução recuperável', () => {
  let id = 0;
  const manager = new ExecutionManager();
  const planner = new ExecutionPlanner({ now: () => 1000 + id, createId: () => `id-${++id}` });
  const original = planner.create('chat-a', 'run-a', 'Recuperar', ['Continuar trabalho']);
  planner.restore([original]);
  const coordinator = new ExecutionCoordinator(manager, planner);

  const resumed = coordinator.resumePlan('chat-a', 'run-a');

  assert.equal(resumed?.steps[0].status, 'running');
});

test('interrupção registra estado antes de liberar o slot e remove plano ativo', () => {
  let id = 0;
  const manager = new ExecutionManager();
  const planner = new ExecutionPlanner({ now: () => 1000 + id, createId: () => `id-${++id}` });
  const coordinator = new ExecutionCoordinator(manager, planner);
  manager.start('chat-a', 1000, 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Tarefa', ['Passo']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);

  const interrupted = coordinator.interrupt('chat-a', 'run-a');
  manager.remove('chat-a');

  assert.equal(interrupted?.state, 'interrupted');
  assert.equal(planner.get('chat-a', 'run-a'), undefined);
  assert.equal(manager.get('chat-a'), undefined);
});

test('timeline restaurada preserva sequence e não duplica o snapshot final', () => {
  const timeline = new ExecutionTimeline(100, () => 5000);
  timeline.record({ type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-a', state: 'running', startedAt: 1000, updatedAt: 1000 } });
  timeline.record({ type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-a', state: 'completed', startedAt: 1000, updatedAt: 1500 } });
  const persisted = timeline.list();

  const restored = new ExecutionTimeline(100, () => 6000);
  restored.restore(persisted);
  assert.equal(restored.record({ type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-a', state: 'completed', startedAt: 1000, updatedAt: 1500 } }).length, 0);

  restored.record({ type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-b', state: 'running', startedAt: 2000, updatedAt: 2000 } });
  assert.equal(restored.list().at(-1)?.sequence, persisted.at(-1)!.sequence + 1);
});

test('timeline usa relógio injetado para remoção determinística', () => {
  const timeline = new ExecutionTimeline(100, () => 4321);
  timeline.record({ type: 'upsert', snapshot: { chatId: 'chat-a', runId: 'run-a', state: 'running', startedAt: 1000, updatedAt: 1000 } });
  const removed = timeline.record({ type: 'remove', chatId: 'chat-a', runId: 'run-a' });

  assert.equal(removed[0].at, 4321);
});
