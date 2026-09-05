import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionPlanHistory } from '../src/execution-plan-history';
import { ExecutionPlanner } from '../src/execution-planner';

function setup(maxRecords = 200) {
  let now = 1000;
  let id = 0;
  const planner = new ExecutionPlanner({ now: () => ++now, createId: () => `id-${++id}` });
  const history = new ExecutionPlanHistory(maxRecords, () => ++now);
  planner.subscribe((change) => history.record(change));
  return { planner, history };
}

test('mantém plano terminal antigo quando um novo plano substitui o atual do chat', () => {
  const { planner, history } = setup();
  const first = planner.create('chat-a', 'run-a', 'Primeira tarefa', ['Executar']);
  planner.startStep('chat-a', 'run-a', first.steps[0].id);
  planner.completeStep('chat-a', 'run-a', first.steps[0].id, [{ type: 'result', summary: 'ok' }]);
  planner.create('chat-a', 'run-b', 'Segunda tarefa', ['Executar']);

  const records = history.list({ chatId: 'chat-a' });
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map((record) => record.runId)), new Set(['run-a', 'run-b']));
  assert.equal(history.list({ runId: 'run-a' })[0].plan.status, 'completed');
});

test('remoção do plano atual arquiva o registro sem apagar evidências', () => {
  const { planner, history } = setup();
  const plan = planner.create('chat-a', 'run-a', 'Tarefa', ['Editar']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.recordEvidence('chat-a', 'run-a', { type: 'file', summary: 'Arquivo editado', reference: 'src/a.ts' });
  planner.remove('chat-a', 'run-a');

  const record = history.list({ chatId: 'chat-a', runId: 'run-a' })[0];
  assert.ok(record.removedAt);
  assert.equal(record.plan.steps[0].evidence[0].reference, 'src/a.ts');
});

test('limite remove os registros mais antigos', () => {
  const { planner, history } = setup(2);
  planner.create('chat-a', 'run-a', 'A', ['A']);
  planner.remove('chat-a', 'run-a');
  planner.create('chat-b', 'run-b', 'B', ['B']);
  planner.remove('chat-b', 'run-b');
  planner.create('chat-c', 'run-c', 'C', ['C']);

  const records = history.list();
  assert.equal(records.length, 2);
  assert.equal(records.some((record) => record.runId === 'run-a'), false);
});

test('restore deduplica por chat e run e preserva o snapshot mais recente', () => {
  const { planner, history } = setup();
  const plan = planner.create('chat-a', 'run-a', 'Tarefa', ['Passo']);
  const first = history.list()[0];
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  const latest = history.list()[0];

  const restored = new ExecutionPlanHistory();
  restored.restore([first, latest]);
  const records = restored.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].plan.status, 'running');
});

test('purgeChat apaga apenas o histórico do chat removido', () => {
  const { planner, history } = setup();
  planner.create('chat-a', 'run-a', 'A', ['A']);
  planner.create('chat-b', 'run-b', 'B', ['B']);

  assert.equal(history.purgeChat('chat-a'), 1);
  assert.equal(history.list({ chatId: 'chat-a' }).length, 0);
  assert.equal(history.list({ chatId: 'chat-b' }).length, 1);
});
