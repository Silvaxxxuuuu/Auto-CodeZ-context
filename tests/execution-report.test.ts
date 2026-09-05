import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager } from '../src/execution-manager';
import { ExecutionPlanHistory } from '../src/execution-plan-history';
import { ExecutionPlanner } from '../src/execution-planner';
import { ExecutionReportBuilder } from '../src/execution-report';
import { ExecutionTimeline } from '../src/execution-timeline';

function setup() {
  let now = 1000;
  let id = 0;
  const executions = new ExecutionManager();
  const timeline = new ExecutionTimeline(100, () => ++now);
  const planner = new ExecutionPlanner({ now: () => ++now, createId: () => `id-${++id}` });
  const history = new ExecutionPlanHistory(100, () => ++now);
  executions.subscribe((change) => timeline.record(change));
  planner.subscribe((change) => history.record(change));
  return { executions, timeline, planner, history, reports: new ExecutionReportBuilder(executions, timeline, history), tick: () => ++now };
}

test('classifica como verified quando execução e plano terminaram com evidência preservada', () => {
  const { executions, planner, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Corrigir login', ['Editar', 'Testar']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'file', summary: 'auth.ts alterado', reference: 'src/auth.ts' }]);
  planner.startStep('chat-a', 'run-a', plan.steps[1].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[1].id, [{ type: 'test', summary: '12 testes passaram', reference: 'npm test' }]);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.completionProof, 'verified');
  assert.equal(report?.steps.completed, 2);
  assert.equal(report?.evidence.file, 1);
  assert.equal(report?.evidence.test, 1);
  assert.equal(report?.plan?.objective, 'Corrigir login');
});

test('execução concluída sem plano fica explicitamente unplanned', () => {
  const { executions, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());

  assert.equal(reports.build('chat-a', 'run-a')?.completionProof, 'unplanned');
});

test('plano incompleto nunca recebe prova verified', () => {
  const { executions, planner, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  planner.create('chat-a', 'run-a', 'Tarefa', ['A', 'B']);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.completionProof, 'incomplete');
  assert.equal(report?.steps.pending, 2);
});

test('reconstrói execução histórica depois que snapshot ativo foi removido', () => {
  const { executions, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  executions.update('chat-a', { state: 'failed', error: 'build falhou', runId: 'run-a' }, tick());
  executions.remove('chat-a');

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.state, 'failed');
  assert.equal(report?.completionProof, 'failed');
  assert.equal(report?.error, 'build falhou');
  assert.ok(report?.timeline.some((event) => event.type === 'removed'));
});

test('reconstrói execução histórica apenas a partir de recovery baseline', () => {
  const executions = new ExecutionManager();
  const timeline = new ExecutionTimeline();
  const history = new ExecutionPlanHistory();
  timeline.restore([{
    sequence: 1,
    chatId: 'chat-a',
    runId: 'run-recovered',
    at: 5000,
    type: 'recovered',
    state: 'interrupted',
    startedAt: 1000,
  }]);
  const reports = new ExecutionReportBuilder(executions, timeline, history);

  const report = reports.build('chat-a', 'run-recovered');
  assert.equal(report?.state, 'interrupted');
  assert.equal(report?.startedAt, 1000);
  assert.equal(report?.updatedAt, 5000);
  assert.equal(report?.completionProof, 'interrupted');
});

test('lista runs históricas em ordem de atualização e isola chats', () => {
  const { executions, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());
  executions.start('chat-b', tick(), 'run-b');
  executions.update('chat-b', { state: 'completed', runId: 'run-b' }, tick());

  assert.deepEqual(reports.list().map((report) => report.runId), ['run-b', 'run-a']);
  assert.deepEqual(reports.list('chat-a').map((report) => report.runId), ['run-a']);
});

test('histórico arquivado continua disponível no relatório', () => {
  const { executions, planner, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Tarefa', ['Passo']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'result', summary: 'feito' }]);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());
  planner.remove('chat-a', 'run-a');

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.completionProof, 'verified');
  assert.equal(report?.planArchived, true);
});
