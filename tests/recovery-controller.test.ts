import { describe, expect, it, vi } from 'vitest';
import { ExecutionManager } from '../src/execution-manager';
import { resumeRecoveredRun } from '../src/agent/recovery-controller';
import type { AgentRuntime } from '../src/agent/agent-runtime';

function createRuntime(result: { chatId: string; pendingApprovalIds: string[] }) {
  return {
    resumeRecovered: vi.fn().mockResolvedValue({
      chatId: result.chatId,
      pendingApprovalIds: result.pendingApprovalIds,
      response: { content: '', model: 'test-model', providerId: 'test-provider' },
      toolRounds: 1,
      messages: [],
    }),
  } as unknown as AgentRuntime;
}

describe('recovery-controller', () => {
  it('restores the persisted run identity in ExecutionManager', async () => {
    const agentRuntime = createRuntime({ chatId: 'chat-test', pendingApprovalIds: [] });
    const executionManager = new ExecutionManager();

    const { result, execution } = await resumeRecoveredRun(
      agentRuntime,
      executionManager,
      { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 2 },
      123,
    );

    expect(result.chatId).toBe('chat-test');
    expect(execution.runId).toBe('persisted-run');
    expect(execution.state).toBe('completed');
    expect(execution.startedAt).toBe(123);
    expect(agentRuntime.resumeRecovered).toHaveBeenCalledWith('persisted-run');
  });

  it('does not replace an active execution', async () => {
    const agentRuntime = createRuntime({ chatId: 'chat-test', pendingApprovalIds: [] });
    const executionManager = new ExecutionManager();
    executionManager.start('chat-test', 100, 'active-run');

    await expect(resumeRecoveredRun(
      agentRuntime,
      executionManager,
      { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 1 },
      200,
    )).rejects.toThrow('já possui uma execução ativa');

    expect(agentRuntime.resumeRecovered).not.toHaveBeenCalled();
    expect(executionManager.get('chat-test')?.runId).toBe('active-run');
  });

  it('keeps the authoritative run identity when recovery fails', async () => {
    const agentRuntime = {
      resumeRecovered: vi.fn().mockRejectedValue(new Error('Provider indisponível.')),
    } as unknown as AgentRuntime;
    const executionManager = new ExecutionManager();

    await expect(resumeRecoveredRun(
      agentRuntime,
      executionManager,
      { runId: 'persisted-run', chatId: 'chat-test', toolRounds: 3 },
      300,
    )).rejects.toThrow('Provider indisponível.');

    expect(executionManager.get('chat-test')).toMatchObject({
      runId: 'persisted-run',
      state: 'failed',
      error: 'Provider indisponível.',
      startedAt: 300,
    });
  });
});
