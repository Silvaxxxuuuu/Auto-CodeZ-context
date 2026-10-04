export type RollbackExecutionSnapshot = {
  chatId: string;
  runId: string;
  state: string;
};

export type RollbackCheckpointChange = {
  path: string;
  type: string;
  addedLines: number;
  removedLines: number;
  renamedFrom?: string;
};

export type RollbackCheckpointTarget = {
  id: string;
  chatId: string;
  runId: string;
  projectId: string;
  toolCallId: string;
  createdAt: number;
  status: 'ready';
  changes: RollbackCheckpointChange[];
};

function isExecutionSnapshot(value: unknown): value is RollbackExecutionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<RollbackExecutionSnapshot>;
  return typeof snapshot.chatId === 'string'
    && Boolean(snapshot.chatId.trim())
    && typeof snapshot.runId === 'string'
    && Boolean(snapshot.runId.trim())
    && typeof snapshot.state === 'string';
}

function isChange(value: unknown): value is RollbackCheckpointChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Partial<RollbackCheckpointChange>;
  return typeof change.path === 'string'
    && Boolean(change.path.trim())
    && typeof change.type === 'string'
    && Boolean(change.type.trim())
    && Number.isInteger(change.addedLines)
    && Number(change.addedLines) >= 0
    && Number.isInteger(change.removedLines)
    && Number(change.removedLines) >= 0
    && (change.renamedFrom === undefined || (typeof change.renamedFrom === 'string' && Boolean(change.renamedFrom.trim())));
}

function isCheckpoint(value: unknown): value is RollbackCheckpointTarget {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<RollbackCheckpointTarget>;
  return typeof checkpoint.id === 'string'
    && Boolean(checkpoint.id.trim())
    && typeof checkpoint.chatId === 'string'
    && Boolean(checkpoint.chatId.trim())
    && typeof checkpoint.runId === 'string'
    && Boolean(checkpoint.runId.trim())
    && typeof checkpoint.projectId === 'string'
    && Boolean(checkpoint.projectId.trim())
    && typeof checkpoint.toolCallId === 'string'
    && Boolean(checkpoint.toolCallId.trim())
    && typeof checkpoint.createdAt === 'number'
    && Number.isFinite(checkpoint.createdAt)
    && checkpoint.createdAt >= 0
    && checkpoint.status === 'ready'
    && Array.isArray(checkpoint.changes)
    && checkpoint.changes.length > 0
    && checkpoint.changes.every(isChange);
}

export function selectRollbackCheckpoint(execution: unknown, checkpoints: unknown): RollbackCheckpointTarget | undefined {
  if (!isExecutionSnapshot(execution)) return undefined;
  if (execution.state !== 'failed' && execution.state !== 'interrupted') return undefined;
  if (!Array.isArray(checkpoints)) return undefined;

  return checkpoints
    .filter(isCheckpoint)
    .filter((checkpoint) => checkpoint.chatId === execution.chatId && checkpoint.runId === execution.runId)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}
