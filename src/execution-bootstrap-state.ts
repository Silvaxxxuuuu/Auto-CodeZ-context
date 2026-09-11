import type { ExecutionSnapshot } from './execution-manager';

export type BootstrapPendingRun = {
  chatId: string;
  runId: string;
};

export type BootstrapRecoverableRun = {
  chatId: string;
  runId: string;
};

function cloneSnapshot(snapshot: ExecutionSnapshot): ExecutionSnapshot {
  return { ...snapshot };
}

function snapshotForRun(
  current: ExecutionSnapshot | undefined,
  run: BootstrapPendingRun | BootstrapRecoverableRun,
  state: 'waiting_approval' | 'interrupted',
  now: number,
): ExecutionSnapshot {
  const sameRun = current?.runId === run.runId;
  const startedAt = sameRun ? current.startedAt : now;
  const updatedAt = sameRun ? Math.max(current.updatedAt, startedAt) : now;
  return {
    chatId: run.chatId,
    runId: run.runId,
    state,
    startedAt,
    updatedAt,
  };
}

export function reconcileExecutionBootstrapState(input: {
  persisted: ExecutionSnapshot[];
  pendingRuns: BootstrapPendingRun[];
  recoverableRuns: BootstrapRecoverableRun[];
  now?: number;
}): ExecutionSnapshot[] {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new Error('Data de reconciliação inválida.');
  if (!Array.isArray(input.persisted) || !Array.isArray(input.pendingRuns) || !Array.isArray(input.recoverableRuns)) {
    throw new Error('Estado de bootstrap inválido.');
  }

  const byChat = new Map<string, ExecutionSnapshot>();
  for (const snapshot of input.persisted) byChat.set(snapshot.chatId, cloneSnapshot(snapshot));

  for (const run of input.recoverableRuns) {
    const current = byChat.get(run.chatId);
    byChat.set(run.chatId, snapshotForRun(current, run, 'interrupted', now));
  }

  for (const run of input.pendingRuns) {
    const current = byChat.get(run.chatId);
    byChat.set(run.chatId, snapshotForRun(current, run, 'waiting_approval', now));
  }

  return [...byChat.values()].map(cloneSnapshot);
}
