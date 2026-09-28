import type { AgentRunStatus } from './contracts';

const transitions: Readonly<Record<AgentRunStatus, ReadonlySet<AgentRunStatus>>> = {
  queued: new Set(['planning', 'running', 'cancelled', 'failed']),
  planning: new Set(['running', 'waiting_approval', 'waiting_external', 'paused', 'failed', 'cancelled']),
  running: new Set(['waiting_approval', 'waiting_external', 'paused', 'recovering', 'completed', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'recovering', 'failed', 'cancelled']),
  waiting_external: new Set(['running', 'recovering', 'failed', 'cancelled']),
  paused: new Set(['running', 'recovering', 'failed', 'cancelled']),
  recovering: new Set(['running', 'waiting_approval', 'waiting_external', 'paused', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function canTransitionRunStatus(from: AgentRunStatus, to: AgentRunStatus): boolean {
  if (from === to) return true;
  return transitions[from].has(to);
}

export function assertRunStatusTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (canTransitionRunStatus(from, to)) return;
  throw new Error(`Transição de execução inválida: ${from} -> ${to}.`);
}
