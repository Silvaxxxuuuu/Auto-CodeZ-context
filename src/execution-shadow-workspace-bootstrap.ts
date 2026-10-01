import type { ShadowWorkspaceSnapshot } from './agent/shadow-workspace';

export type ShadowRunIdentity = {
  chatId: string;
  runId: string;
};

function keyOf(chatId: string, runId: string): string {
  return `${chatId.trim()}\u0000${runId.trim()}`;
}

function validIdentity(value: ShadowRunIdentity): boolean {
  return typeof value?.chatId === 'string'
    && Boolean(value.chatId.trim())
    && typeof value?.runId === 'string'
    && Boolean(value.runId.trim());
}

function cloneSnapshot(snapshot: ShadowWorkspaceSnapshot): ShadowWorkspaceSnapshot {
  return {
    ...snapshot,
    changes: snapshot.changes.map((change) => ({ ...change })),
  };
}

export function reconcileShadowWorkspaceBootstrap(
  snapshots: ShadowWorkspaceSnapshot[],
  pendingRuns: ShadowRunIdentity[],
  recoverableRuns: ShadowRunIdentity[],
): ShadowWorkspaceSnapshot[] {
  if (!Array.isArray(snapshots) || !Array.isArray(pendingRuns) || !Array.isArray(recoverableRuns)) {
    throw new Error('Estado de bootstrap do Shadow Workspace inválido.');
  }

  const activeRuns = new Set<string>();
  for (const run of [...pendingRuns, ...recoverableRuns]) {
    if (!validIdentity(run)) continue;
    activeRuns.add(keyOf(run.chatId, run.runId));
  }

  const byRun = new Map<string, ShadowWorkspaceSnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.status !== 'active') continue;
    if (typeof snapshot.chatId !== 'string' || typeof snapshot.runId !== 'string') continue;
    const key = keyOf(snapshot.chatId, snapshot.runId);
    if (!activeRuns.has(key)) continue;
    const current = byRun.get(key);
    if (!current || snapshot.updatedAt >= current.updatedAt) byRun.set(key, cloneSnapshot(snapshot));
  }

  return [...byRun.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.runId.localeCompare(right.runId))
    .map(cloneSnapshot);
}
