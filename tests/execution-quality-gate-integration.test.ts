import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager } from '../src/execution-manager';
import { ExecutionPlanHistory } from '../src/execution-plan-history';
import { ExecutionPlanner } from '../src/execution-planner';
import { ExecutionQualityGateRuntime } from '../src/execution-quality-gate';
import { ExecutionReportBuilder } from '../src/execution-report';
import { ExecutionTimeline } from '../src/execution-timeline';

test('pipeline completo só aprova quality gate com plano concluído e evidência objetiva', () => {
  let now = 1000;
  let id = 0;
  const executions = new ExecutionManager();
  const timeline = new ExecutionTimeline(100, () => ++now);
  const planner = new ExecutionPlanner({ now: () => ++now, createId: () => `plan-${++id}` });
  const history = new ExecutionPlanHistory(100, () => ++now);
  const reports = new ExecutionReportBuilder(executions, timeline, history);
  const gates = new ExecutionQualityGateRuntime(() => ++now, () => `gate-${++id}`);

  executions.subscribe((change) => timeline.record(change));
  planner.subscribe((change) => history.record(change));

  executions.start('chat-a', ++now, 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Entregar alteração validada', ['Editar', 'Testar', 'Build']);
  gates.configure({
    chatId: 'chat-a',
    runId: 'run-a',
    requirements: [
      { type: 'file', minimum: 1 },
      { type: 'test', minimum: 1 },
      { type: 'build', minimum: 1 },
    ],
  });

  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'file', summary: 'Arquivo alterado', reference: 'src/app.ts' }]);
  planner.startStep('chat-a', 'run-a', plan.steps[1].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[1].id, [{ type: 'test', summary: 'Testes passaram', reference: 'npm test' }]);

  const beforeBuild = reports.build('chat-a', 'run-a');
  assert.equal(beforeBuild?.completionProof, 'active');
  assert.equal(gates.evaluate(beforeBuild)?.status, 'pending');

  planner.startStep('chat-a', 'run-a', plan.steps[2].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[2].id, [{ type: 'build', summary: 'Build passou', reference: 'npm run build' }]);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, ++now);

  const finalReport = reports.build('chat-a', 'run-a');
  const evaluation = gates.evaluate(finalReport);
  assert.equal(finalReport?.completionProof, 'verified');
  assert.equal(evaluation?.status, 'passed');
  assert.equal(evaluation?.checks.every((check) => check.passed), true);
});

test('falha da execução mantém quality gate falhado mesmo quando há evidências anteriores', () => {
  let now = 2000;
  let id = 0;
  const executions = new ExecutionManager();
  const timeline = new ExecutionTimeline(100, () => ++now);
  const planner = new ExecutionPlanner({ now: () => ++now, createId: () => `plan-${++id}` });
  const history = new ExecutionPlanHistory(100, () => ++now);
  const reports = new ExecutionReportBuilder(executions, timeline, history);
  const gates = new ExecutionQualityGateRuntime(() => ++now, () => `gate-${++id}`);

  executions.subscribe((change) => timeline.record(change));
  planner.subscribe((change) => history.record(change));

  executions.start('chat-a', ++now, 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Tarefa que falha', ['Testar']);
  gates.configure({ chatId: 'chat-a', runId: 'run-a', requirements: [{ type: 'test', minimum: 1 }] });
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.failStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'test', summary: 'Teste executado e falhou', reference: 'npm test' }]);
  executions.update('chat-a', { state: 'failed', error: 'npm test falhou', runId: 'run-a' }, ++now);

  const evaluation = gates.evaluate(reports.build('chat-a', 'run-a'));
  assert.equal(evaluation?.status, 'failed');
  assert.equal(evaluation?.reason, 'npm test falhou');
});
