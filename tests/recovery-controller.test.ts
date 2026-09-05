import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager } from '../src/execution-manager';
import { resumeRecoveredRun } from '../src/agent/recovery-controller';
import { isExplicitProviderRecovery } from '../src/ai/provider-recovery-context';
import type { AgentRuntime } from '../src/agent/agent-runtime';

function createRuntime(result: { chatId: string; pendingApprovalIds: string[] }) {
  const resumeRecovered = async () => ({
    chatId: result.chatId,
    pendingApprovalIds: result.pendingApprovalIds,
    response: { content: '', model: 'test-model', providerId: 'test-provider' },
    toolRounds: 1,
    messages: [] as never[],
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

  const execution = executionManager.get('chat-test');
  assert.equal(execution?.chatId, 'chat-test');
  assert.equal(execution?.runId, 'persisted-run');
  assert.equal(execution?.state, 'failed');
  assert.equal(execution?.startedAt, 300);
  assert.equal(execution?.error, 'Provider indisponível.');
});

test('recovery-controller removes the active snapshot when recovery is cancelled', async () => {
  const controller = new AbortController();
  const agentRuntime = {
    resumeRecovered: async (_runId: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        const error = new Error('Operação cancelada.');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    }),
  } as unknown as AgentRuntime;
  const executionManager = new ExecutionManager();

  const recovery = resumeRecoveredRun(
    agentRuntime,
    executionManager,
    { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 3 },
    400,
    controller.signal,
  );
  controller.abort();

  await assert.rejects(recovery, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(executionManager.get('chat-test'), undefined);
});

test('recovery-controller scopes provider retry permission only to the explicit recovery operation', async () => {
  let observedDuringRecovery = false;
  const agentRuntime = {
    resumeRecovered: async () => {
      await Promise.resolve();
      observedDuringRecovery = isExplicitProviderRecovery();
      return {
        chatId: 'chat-test',
        pendingApprovalIds: [],
        response: { content: '', model: 'test-model', providerId: 'test-provider' },
        toolRounds: 1,
        messages: [],
      };
    },
  } as unknown as AgentRuntime;
  const executionManager = new ExecutionManager();

  assert.equal(isExplicitProviderRecovery(), false);
  await resumeRecoveredRun(
    agentRuntime,
    executionManager,
    { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 1 },
    500,
  );

  assert.equal(observedDuringRecovery, true);
  assert.equal(isExplicitProviderRecovery(), false);
});
