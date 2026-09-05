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

function recoveryJournalRetained(agentRuntime: AgentRuntime, recoverable: RecoverableRun): boolean {
  if (typeof agentRuntime.listRecoverableRuns !== 'function') return false;
  return agentRuntime.listRecoverableRuns().some((run) => run.runId === recoverable.runId && run.chatId === recoverable.chatId);
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
  if (existing && existing.runId !== recoverable.runId) {
    throw new Error(`A execução recuperável ${recoverable.runId} não corresponde ao snapshot atual do chat ${recoverable.chatId}.`);
  }

  if (existing) executionManager.resumeInterrupted(recoverable.chatId, recoverable.runId, now);
  else executionManager.start(recoverable.chatId, now, recoverable.runId);

  try {
    const result = await runWithExplicitProviderRecovery(() => agentRuntime.resumeRecovered(recoverable.runId, signal));
    signal?.throwIfAborted();
    const state = result.pendingApprovalIds.length ? 'waiting_approval' : deferCompletion ? 'running' : 'completed';
    const execution = executionManager.update(recoverable.chatId, {
      state,
      runId: recoverable.runId,
    }, now);
    return { result, execution };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      executionManager.remove(recoverable.chatId);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const retained = recoveryJournalRetained(agentRuntime, recoverable);
    const execution = executionManager.update(recoverable.chatId, retained
      ? { state: 'interrupted', runId: recoverable.runId }
      : { state: 'failed', error: message, runId: recoverable.runId }, now);
    throw Object.assign(error instanceof Error ? error : new Error(message), { execution, recoverable: retained });
  }
}
