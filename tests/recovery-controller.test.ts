import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager } from '../src/execution-manager';
import { resumeRecoveredRun } from '../src/agent/recovery-controller';
import type { AgentRuntime } from '../src/agent/agent-runtime';

function createRuntime(result: { chatId: string; pendingApprovalIds: string[] }) {
  const resumeRecovered = async () => ({
    chatId: result.chatId,
    pendingApprovalIds: result.pendingApprovalIds,
    response: { content: '', model: 'test-model', providerId: 'test-provider' },
    toolRounds: 1,
    messages: [],
  });

  return {
    resumeRecovered,
  } as unknown as AgentRuntime & { resumeRecovered: typeof resumeRecovered };
}

test('recovery-controller restores the persisted run identity in ExecutionManager', async () => {
  const agentRuntime = createRuntime({ chatId: 'chat-test', pendingApprovalIds: [] });
  const executionManager = new ExecutionManager();

  const { result, execution } = await resumeRecoveredRun(
    agentRuntime,
    executionManager,
    { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 2 },
    123,
  );

  assert.equal(result.chatId, 'chat-test');
  assert.equal(execution.runId, 'persisted-run');
  assert.equal(execution.state, 'completed');
  assert.equal(execution.startedAt, 123);
});

test('recovery-controller does not replace an active execution', async () => {
  const agentRuntime = createRuntime({ chatId: 'chat-test', pendingApprovalIds: [] });
  const executionManager = new ExecutionManager();
  executionManager.start('chat-test', 100, 'active-run');

  await assert.rejects(
    resumeRecoveredRun(
      agentRuntime,
      executionManager,
      { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 1 },
      200,
    ),
    /já possui uma execução ativa/,
  );

  assert.equal(executionManager.get('chat-test')?.runId, 'active-run');
});

test('recovery-controller keeps the authoritative run identity when recovery fails', async () => {
  const agentRuntime = {
    resumeRecovered: async () => {
      throw new Error('Provider indisponível.');
    },
  } as unknown as AgentRuntime;
  const executionManager = new ExecutionManager();

  await assert.rejects(
    resumeRecoveredRun(
      agentRuntime,
      executionManager,
      { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 3 },
      300,
    ),
    /Provider indisponível\./,
  );

  assert.deepEqual(executionManager.get('chat-test'), {
    chatId: 'chat-test',
    runId: 'persisted-run',
    state: 'failed',
    startedAt: 300,
    updatedAt: 300,
    error: 'Provider indisponível.',
    currentTool: undefined,
  });
});
