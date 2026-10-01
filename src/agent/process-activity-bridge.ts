import { AGENT_CORE_V2_CONTRACT_VERSION, type StructuredActivityEvent, type StructuredActivityPhase } from '../agent-core/contracts';
import type { ManagedProcessSnapshot } from './process-runtime';

export function toStructuredProcessLifecycleActivity(snapshot: ManagedProcessSnapshot): StructuredActivityEvent | undefined {
  if (!snapshot.chatId || !snapshot.runId || !snapshot.toolCallId || !snapshot.executionId) return undefined;
  const phase: StructuredActivityPhase = snapshot.status === 'running'
    ? 'running'
    : snapshot.status === 'exited'
      ? 'completed'
      : snapshot.status === 'stopped'
        ? 'cancelled'
        : 'failed';
  const at = snapshot.finishedAt ?? snapshot.startedAt;
  return {
    contractVersion: AGENT_CORE_V2_CONTRACT_VERSION,
    id: `execution:${snapshot.executionId}:${phase}:${at}`,
    kind: 'process',
    phase,
    chatId: snapshot.chatId,
    runId: snapshot.runId,
    toolCallId: snapshot.toolCallId,
    toolName: 'start_process',
    executionId: snapshot.executionId,
    capabilityId: snapshot.capabilityId ?? 'process.start',
    subject: { processId: snapshot.id, command: snapshot.command },
    summary: snapshot.status === 'running'
      ? `Processo iniciado: ${snapshot.command}`
      : snapshot.status === 'exited'
        ? `Processo concluído com código ${snapshot.exitCode ?? 0}.`
        : snapshot.status === 'stopped'
          ? 'Processo interrompido.'
          : `Processo falhou${snapshot.error ? `: ${snapshot.error}` : '.'}`,
    ...(snapshot.finishedAt !== undefined ? { durationMs: Math.max(0, snapshot.finishedAt - snapshot.startedAt) } : {}),
    createdAt: at,
  };
}
