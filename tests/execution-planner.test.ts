import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionPlanner } from '../src/execution-planner';

function planner() {
  let now = 1000;
  let id = 0;
  return {
    runtime: new ExecutionPlanner({
      now: () => ++now,
      createId: () => `id-${++id}`,
    }),
    tick: () => ++now,
  };
}

test('cria plano determinístico com passos pendentes', () => {
  const { runtime } = planner();
  const plan = runtime.create('chat-a', 'run-a', 'Corrigir login', ['Inspecionar', 'Editar', 'Testar']);

  assert.equal(plan.chatId, 'chat-a');
  assert.equal(plan.runId, 'run-a');
  assert.equal(plan.objective, 'Corrigir login');
  assert.equal(plan.status, 'pending');
  assert.deepEqual(plan.steps.map((step) => step.status), ['pending', 'pending', 'pending']);
  assert.equal(runtime.get('chat-a', 'run-a')?.id, plan.id);
});

test('executa passos em ordem e deriva estado do plano', () => {
  const { runtime } = planner();
  const created = runtime.create('chat-a', 'run-a', 'Objetivo', ['Primeiro', 'Segundo']);
  const [first, second] = created.steps;

  assert.throws(() => runtime.startStep('chat-a', 'run-a', second.id), /ordem/);

  const running = runtime.startStep('chat-a', 'run-a', first.id);
  assert.equal(running.status, 'running');
  assert.equal(running.steps[0].status, 'running');

  const afterFirst = runtime.completeStep('chat-a', 'run-a', first.id);
  assert.equal(afterFirst.status, 'running');
  assert.equal(afterFirst.steps[0].status, 'completed');

  runtime.startStep('chat-a', 'run-a', second.id);
  const completed = runtime.completeStep('chat-a', 'run-a', second.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.steps.map((step) => step.status), ['completed', 'completed']);
});

test('falha de passo torna o plano terminal', () => {
  const { runtime } = planner();
  const created = runtime.create('chat-a', 'run-a', 'Objetivo', ['Executar', 'Revisar']);
  const first = created.steps[0];

  runtime.startStep('chat-a', 'run-a', first.id);
  const failed = runtime.failStep('chat-a', 'run-a', first.id, [
    { type: 'test', summary: 'Teste falhou', reference: 'npm test' },
  ]);

  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps[0].status, 'failed');
  assert.equal(failed.steps[0].evidence[0].type, 'test');
  assert.throws(() => runtime.startStep('chat-a', 'run-a', created.steps[1].id), /terminal/);
});

test('skip respeita ordem e pode concluir plano', () => {
  const { runtime } = planner();
  const created = runtime.create('chat-a', 'run-a', 'Objetivo', ['Opcional', 'Final']);

  const afterSkip = runtime.skipStep('chat-a', 'run-a', created.steps[0].id, [
    { type: 'result', summary: 'Etapa desnecessária' },
  ]);
  assert.equal(afterSkip.status, 'running');
  assert.equal(afterSkip.steps[0].status, 'skipped');

  runtime.startStep('chat-a', 'run-a', created.steps[1].id);
  const completed = runtime.completeStep('chat-a', 'run-a', created.steps[1].id);
  assert.equal(completed.status, 'completed');
});

test('impede dois passos simultâneos e transições inválidas', () => {
  const { runtime } = planner();
  const created = runtime.create('chat-a', 'run-a', 'Objetivo', ['A', 'B']);
  const first = created.steps[0];

  runtime.startStep('chat-a', 'run-a', first.id);
  assert.throws(() => runtime.startStep('chat-a', 'run-a', first.id), /pendente/);
  assert.throws(() => runtime.completeStep('chat-a', 'run-a', created.steps[1].id), /execução/);
  assert.throws(() => runtime.skipStep('chat-a', 'run-a', created.steps[1].id), /ordem/);
});

test('isola planos por chat e run', () => {
  const { runtime } = planner();
  const first = runtime.create('chat-a', 'run-a', 'A', ['Passo A']);
  const second = runtime.create('chat-b', 'run-b', 'B', ['Passo B']);

  assert.equal(runtime.get('chat-a', 'run-b'), undefined);
  assert.equal(runtime.get('chat-a', 'run-a')?.id, first.id);
  assert.equal(runtime.get('chat-b', 'run-b')?.id, second.id);
  assert.equal(runtime.list().length, 2);
});

test('não permite duplicar plano ativo da mesma execução', () => {
  const { runtime } = planner();
  runtime.create('chat-a', 'run-a', 'A', ['Passo']);
  assert.throws(() => runtime.create('chat-a', 'run-a', 'B', ['Passo']), /plano ativo/);
});

test('permite novo plano no mesmo chat depois de estado terminal', () => {
  const { runtime } = planner();
  const first = runtime.create('chat-a', 'run-a', 'A', ['Passo']);
  runtime.startStep('chat-a', 'run-a', first.steps[0].id);
  runtime.completeStep('chat-a', 'run-a', first.steps[0].id);

  const second = runtime.create('chat-a', 'run-b', 'B', ['Outro passo']);
  assert.equal(runtime.get('chat-a')?.runId, 'run-b');
  assert.equal(second.status, 'pending');
});

test('devolve cópias defensivas e protege evidências internas', () => {
  const { runtime } = planner();
  const created = runtime.create('chat-a', 'run-a', 'Objetivo', ['Passo']);
  runtime.startStep('chat-a', 'run-a', created.steps[0].id);
  const completed = runtime.completeStep('chat-a', 'run-a', created.steps[0].id, [
    { type: 'tool', summary: 'read_file concluído', reference: 'src/a.ts' },
  ]);

  completed.objective = 'mutado';
  completed.steps[0].title = 'mutado';
  completed.steps[0].evidence[0].summary = 'mutado';

  const stored = runtime.get('chat-a', 'run-a');
  assert.equal(stored?.objective, 'Objetivo');
  assert.equal(stored?.steps[0].title, 'Passo');
  assert.equal(stored?.steps[0].evidence[0].summary, 'read_file concluído');
});

test('observadores recebem cópias e falhas de observer não interrompem transições', () => {
  const { runtime } = planner();
  const observed: string[] = [];

  runtime.subscribe((change) => {
    observed.push(change.type);
    if (change.type === 'upsert') change.plan.objective = 'externo';
  });
  runtime.subscribe(() => {
    throw new Error('observer falhou');
  });

  const created = runtime.create('chat-a', 'run-a', 'Objetivo', ['Passo']);
  runtime.startStep('chat-a', 'run-a', created.steps[0].id);

  assert.deepEqual(observed, ['upsert', 'upsert']);
  assert.equal(runtime.get('chat-a', 'run-a')?.objective, 'Objetivo');
});

test('remove exige run correta e publica remoção', () => {
  const { runtime } = planner();
  const changes: string[] = [];
  runtime.subscribe((change) => changes.push(change.type));
  runtime.create('chat-a', 'run-a', 'Objetivo', ['Passo']);

  assert.equal(runtime.remove('chat-a', 'run-b'), false);
  assert.equal(runtime.remove('chat-a', 'run-a'), true);
  assert.equal(runtime.get('chat-a'), undefined);
  assert.deepEqual(changes, ['upsert', 'remove']);
});

test('valida entradas e limites básicos', () => {
  const { runtime } = planner();

  assert.throws(() => runtime.create('', 'run-a', 'Objetivo', ['Passo']), /Chat/);
  assert.throws(() => runtime.create('chat-a', '', 'Objetivo', ['Passo']), /Execução/);
  assert.throws(() => runtime.create('chat-a', 'run-a', '', ['Passo']), /Objetivo/);
  assert.throws(() => runtime.create('chat-a', 'run-a', 'Objetivo', []), /pelo menos um passo/);
  assert.throws(() => runtime.create('chat-a', 'run-a', 'Objetivo', ['']), /Passo/);
});
