import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntime } from '../src/agent/agent-runtime';
import { resumeRecoveredRun } from '../src/agent/recovery-controller';
import { ExecutionCoordinator } from '../src/execution-coordinator';
import { ExecutionManager } from '../src/execution-manager';
import { ExecutionPlanner } from '../src/execution-planner';

const recoverable = { runId: 'run-a', chatId: 'chat-a', toolRounds: 2 };

test('falha transitória mantém journal e devolve execução para interrupted', async () => {
  const runtime = {
    listRecoverableRuns: () => [recoverable],
    resumeRecovered: async () => {
      throw new Error('Provider temporariamente indisponível.');
    },
  } as unknown as AgentRuntime;
  const manager = new ExecutionManager();
  manager.hydrate([{
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'interrupted',
    startedAt: 100,
    updatedAt: 200,
  }]);

  await assert.rejects(
    resumeRecoveredRun(runtime, manager, recoverable, 300),
    (error: unknown) => error instanceof Error
      && error.message === 'Provider temporariamente indisponível.'
      && (error as Error & { recoverable?: boolean }).recoverable === true,
  );

  const snapshot = manager.get('chat-a');
  assert.equal(snapshot?.runId, 'run-a');
  assert.equal(snapshot?.state, 'interrupted');
  assert.equal(snapshot?.startedAt, 100);
  assert.equal(snapshot?.error, undefined);
});

test('mesma execução pode ser retomada novamente depois de falha transitória', async () => {
  let attempts = 0;
  const runtime = {
    listRecoverableRuns: () => [recoverable],
    resumeRecovered: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Falha transitória.');
      return {
        chatId: 'chat-a',
        pendingApprovalIds: [] as string[],
        response: { content: 'ok', model: 'test-model', providerId: 'test-provider' },
        toolRounds: 3,
        messages: [] as never[],
      };
    },
  } as unknown as AgentRuntime;
  const manager = new ExecutionManager();
  manager.hydrate([{
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'interrupted',
    startedAt: 100,
    updatedAt: 200,
  }]);

  await assert.rejects(resumeRecoveredRun(runtime, manager, recoverable, 300), /Falha transitória/);
  assert.equal(manager.get('chat-a')?.state, 'interrupted');

  const second = await resumeRecoveredRun(runtime, manager, recoverable, 400);
  assert.equal(second.execution.state, 'completed');
  assert.equal(second.execution.runId, 'run-a');
  assert.equal(second.execution.startedAt, 100);
  assert.equal(attempts, 2);
});

test('journal consumido mantém semântica terminal de falha', async () => {
  const runtime = {
    listRecoverableRuns: () => [],
    resumeRecovered: async () => {
      throw new Error('Execução não é mais recuperável.');
    },
  } as unknown as AgentRuntime;
  const manager = new ExecutionManager();

  await assert.rejects(resumeRecoveredRun(runtime, manager, recoverable, 300), /não é mais recuperável/);

  const snapshot = manager.get('chat-a');
  assert.equal(snapshot?.state, 'failed');
  assert.equal(snapshot?.error, 'Execução não é mais recuperável.');
});

test('coordinator não falha plano quando recovery voltou para interrupted', () => {
  let now = 1000;
  let id = 0;
  const manager = new ExecutionManager();
  const planner = new ExecutionPlanner({
    now: () => ++now,
    createId: () => `id-${++id}`,
  });
  const coordinator = new ExecutionCoordinator(manager, planner);

  const plan = planner.create('chat-a', 'run-a', 'Recuperar tarefa', ['Continuar implementação']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  manager.hydrate([{
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'interrupted',
    startedAt: 100,
    updatedAt: 300,
  }]);

  const completion = coordinator.fail('chat-a', 'run-a', 'Provider temporariamente indisponível.');

  assert.equal(completion.execution.state, 'interrupted');
  assert.equal(completion.plan?.status, 'running');
  assert.equal(completion.plan?.steps[0].status, 'running');
  assert.equal(completion.error, 'Provider temporariamente indisponível.');
  assert.equal(planner.get('chat-a', 'run-a')?.status, 'running');
});
