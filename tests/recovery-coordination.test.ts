import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntime } from '../src/agent/agent-runtime';
import { resumeRecoveredRun } from '../src/agent/recovery-controller';
import { ExecutionManager } from '../src/execution-manager';

function runtime(pendingApprovalIds: string[] = []): AgentRuntime {
  return {
    resumeRecovered: async () => ({
      chatId: 'chat-a',
      pendingApprovalIds,
      response: { content: '', model: 'model', providerId: 'provider' },
      toolRounds: 1,
      messages: [] as never[],
    }),
  } as unknown as AgentRuntime;
}

test('recovery pode deferir conclusão terminal para o coordinator', async () => {
  const manager = new ExecutionManager();
  const result = await resumeRecoveredRun(
    runtime(),
    manager,
    { runId: 'run-a', chatId: 'chat-a', toolRounds: 1 },
    1000,
    undefined,
    true,
  );

  assert.equal(result.execution.state, 'running');
  assert.equal(result.execution.runId, 'run-a');
});

test('deferCompletion não altera waiting_approval quando ainda há aprovação pendente', async () => {
  const manager = new ExecutionManager();
  const result = await resumeRecoveredRun(
    runtime(['approval-a']),
    manager,
    { runId: 'run-a', chatId: 'chat-a', toolRounds: 1 },
    1000,
    undefined,
    true,
  );

  assert.equal(result.execution.state, 'waiting_approval');
});
