import type { AgentRunResult, AgentRuntime } from './agent-runtime';
import type { ExecutionManager, ExecutionSnapshot } from '../execution-manager';
import { runWithExplicitProviderRecovery } from '../ai/provider-recovery-context';

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
  signal?: AbortSignal,
  deferCompletion = false,
): Promise<RecoveryResult> {
  signal?.throwIfAborted();
  const existing = executionManager.get(recoverable.chatId);
  if (existing && (existing.state === 'running' || existing.state === 'waiting_approval')) {
    throw new Error(`O chat ${recoverable.chatId} já possui uma execução ativa.`);
  }

  executionManager.start(recoverable.chatId, now, recoverable.runId);

  try {
    const result = await runWithExplicitProviderRecovery(() => agentRuntime.resumeRecovered(recoverable.runId, signal));
    signal?.throwIfAborted();
    const state = result.pendingApprovalIds.length ? 'waiting_approval' : deferCompletion ? 'running' : 'completed';
    const execution = executionManager.update(recoverable.chatId, {
      state,
      runId: recoverable.runId,
    });
    return { result, execution };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      executionManager.remove(recoverable.chatId);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const execution = executionManager.update(recoverable.chatId, {
      state: 'failed',
      error: message,
      runId: recoverable.runId,
    });
    throw Object.assign(error instanceof Error ? error : new Error(message), { execution });
  }
}
