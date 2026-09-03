import type { AgentRunResult, AgentRuntime } from './agent-runtime';
import type { ExecutionManager, ExecutionSnapshot } from '../execution-manager';

export type RecoverableRun = {
  runId: string;
  chatId: string;
  toolRounds: number;
};

export type RecoveryResult = {
  result: AgentRunResult;
  execution: ExecutionSnapshot;
};

export function listRecoverableRuns(agentRuntime: AgentRuntime): RecoverableRun[] {
  return agentRuntime.listRecoverableRuns();
}

export async function resumeRecoveredRun(
  agentRuntime: AgentRuntime,
  executionManager: ExecutionManager,
  recoverable: RecoverableRun,
  now = Date.now(),
): Promise<RecoveryResult> {
  const existing = executionManager.get(recoverable.chatId);
  if (existing && (existing.state === 'running' || existing.state === 'waiting_approval')) {
    throw new Error(`O chat ${recoverable.chatId} já possui uma execução ativa.`);
  }

  executionManager.start(recoverable.chatId, now, recoverable.runId);

  try {
    const result = await agentRuntime.resumeRecovered(recoverable.runId);
    const state = result.pendingApprovalIds.length ? 'waiting_approval' : 'completed';
    const execution = executionManager.update(recoverable.chatId, {
      state,
      runId: recoverable.runId,
    });
    return { result, execution };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const execution = executionManager.update(recoverable.chatId, {
      state: 'failed',
      error: message,
      runId: recoverable.runId,
    });
    throw Object.assign(error instanceof Error ? error : new Error(message), { execution });
  }
}
