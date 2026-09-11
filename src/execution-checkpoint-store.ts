import type { LocalStorage } from './core/storage';
import type { ExecutionCheckpoint } from './execution-checkpoint';
import type { FileDiff } from './ai/types';

const DEFAULT_FILE = 'execution-checkpoints.json';

type StoredExecutionCheckpoints = {
  version: 1;
  checkpoints: ExecutionCheckpoint[];
};

function cloneChanges(changes: FileDiff[]): FileDiff[] {
  return changes.map((change) => ({ ...change }));
}

function cloneCheckpoint(checkpoint: ExecutionCheckpoint): ExecutionCheckpoint {
  return { ...checkpoint, changes: cloneChanges(checkpoint.changes) };
}

function isFileDiff(value: unknown): value is FileDiff {
  if (!value || typeof value !== 'object') return false;
  const change = value as Partial<FileDiff>;
  if (!['created', 'modified', 'deleted', 'renamed'].includes(String(change.type))) return false;
  if (typeof change.path !== 'string' || !change.path.trim()) return false;
  if (typeof change.before !== 'string' || typeof change.after !== 'string') return false;
  if (!Number.isInteger(change.addedLines) || Number(change.addedLines) < 0) return false;
  if (!Number.isInteger(change.removedLines) || Number(change.removedLines) < 0) return false;
  if (change.type === 'renamed') return typeof change.renamedFrom === 'string' && Boolean(change.renamedFrom.trim());
  return change.renamedFrom === undefined;
}

function isCheckpoint(value: unknown): value is ExecutionCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<ExecutionCheckpoint>;
  if (typeof checkpoint.id !== 'string' || !checkpoint.id.trim()) return false;
  if (typeof checkpoint.chatId !== 'string' || !checkpoint.chatId.trim()) return false;
  if (typeof checkpoint.runId !== 'string' || !checkpoint.runId.trim()) return false;
  if (typeof checkpoint.projectId !== 'string' || !checkpoint.projectId.trim()) return false;
  if (typeof checkpoint.toolCallId !== 'string' || !checkpoint.toolCallId.trim()) return false;
  if (checkpoint.status !== 'ready' && checkpoint.status !== 'restored') return false;
  if (typeof checkpoint.createdAt !== 'number' || !Number.isFinite(checkpoint.createdAt) || checkpoint.createdAt < 0) return false;
  if (!Array.isArray(checkpoint.changes) || checkpoint.changes.length === 0 || checkpoint.changes.some((change) => !isFileDiff(change))) return false;
  if (checkpoint.status === 'ready') return checkpoint.restoredAt === undefined;
  return typeof checkpoint.restoredAt === 'number'
    && Number.isFinite(checkpoint.restoredAt)
    && checkpoint.restoredAt >= checkpoint.createdAt;
}

export class ExecutionCheckpointStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionCheckpoint[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, checkpoints: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionCheckpoints>;
    if (value.version !== 1 || !Array.isArray(value.checkpoints)) return [];

    const byId = new Map<string, ExecutionCheckpoint>();
    for (const candidate of value.checkpoints) {
      if (!isCheckpoint(candidate)) continue;
      const current = byId.get(candidate.id);
      if (!current || candidate.createdAt >= current.createdAt) byId.set(candidate.id, cloneCheckpoint(candidate));
    }
    return [...byId.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(cloneCheckpoint);
  }

  async save(checkpoints: ExecutionCheckpoint[]): Promise<void> {
    const safeCheckpoints = checkpoints
      .filter(isCheckpoint)
      .map(cloneCheckpoint);
    await this.storage.write<StoredExecutionCheckpoints>(this.fileName, { version: 1, checkpoints: safeCheckpoints });
  }
}

export class ExecutionCheckpointPersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionCheckpointStore) {}

  schedule(checkpoints: ExecutionCheckpoint[]): void {
    const copy = checkpoints.map(cloneCheckpoint);
    this.pending = this.pending
      .catch((): void => {})
      .then(async (): Promise<void> => {
        try {
          await this.store.save(copy);
          this.lastError = undefined;
        } catch (error) {
          this.lastError = error instanceof Error ? error : new Error(String(error));
        }
      });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.lastError) throw this.lastError;
  }
}
