import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionCoordinator } from '../src/execution-coordinator';
import { ExecutionManager } from '../src/execution-manager';
import { ExecutionPlanner } from '../src/execution-planner';

function fixture() {
  const executions = new ExecutionManager();
  const planner = new ExecutionPlanner();
  const coordinator = new ExecutionCoordinator(executions, planner);
  executions.start('chat-a', 100, 'run-a');
  return { executions, planner, coordinator };
}

test('preflight permite conclusão quando não existe plano', () => {
  const { coordinator, executions } = fixture();

  const preflight = coordinator.completionPreflight('chat-a', 'run-a');

  assert.equal(preflight.allowed, true);
  assert.equal(preflight.error, undefined);
  assert.equal(executions.get('chat-a')?.state, 'running');
});

test('preflight de plano incompleto é puro e não falha o plano nem a execução', () => {
  const { coordinator, executions, planner } = fixture();
  const plan = planner.create('chat-a', 'run-a', 'Do work', ['Step one']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);

  const before = planner.get('chat-a', 'run-a');
  const preflight = coordinator.completionPreflight('chat-a', 'run-a');
  const after = planner.get('chat-a', 'run-a');

  assert.equal(preflight.allowed, false);
  assert.match(preflight.error ?? '', /antes de concluir o plano/i);
  assert.deepEqual(after, before);
  assert.equal(executions.get('chat-a')?.state, 'running');
});

test('preflight permite plano concluído', () => {
  const { coordinator, planner } = fixture();
  const plan = planner.create('chat-a', 'run-a', 'Do work', ['Step one']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.recordEvidence('chat-a', 'run-a', { type: 'tool', summary: 'done' });
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id);

  const preflight = coordinator.completionPreflight('chat-a', 'run-a');

  assert.equal(preflight.allowed, true);
  assert.equal(preflight.plan?.status, 'completed');
});

test('preflight rejeita plano já falhado sem alterar estado', () => {
  const { coordinator, executions, planner } = fixture();
  const plan = planner.create('chat-a', 'run-a', 'Do work', ['Step one']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.failStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'result', summary: 'failed' }]);

  const preflight = coordinator.completionPreflight('chat-a', 'run-a');

  assert.equal(preflight.allowed, false);
  assert.match(preflight.error ?? '', /plano declarado terminou com falha/i);
  assert.equal(executions.get('chat-a')?.state, 'running');
  assert.equal(planner.get('chat-a', 'run-a')?.status, 'failed');
});
