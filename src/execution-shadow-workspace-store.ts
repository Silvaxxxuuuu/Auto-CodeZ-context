import type { LocalStorage } from './core/storage';
import type { FileDiff } from './ai/types';
import type { ShadowWorkspaceSnapshot } from './agent/shadow-workspace';

const DEFAULT_FILE = 'execution-shadow-workspaces.json';

type StoredShadowWorkspaces = {
  version: 1;
  snapshots: ShadowWorkspaceSnapshot[];
};

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFileDiff(value: unknown): value is FileDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const change = value as Partial<FileDiff>;
  if (!['created', 'modified', 'deleted', 'renamed'].includes(String(change.type))) return false;
  if (typeof change.path !== 'string' || !change.path.trim()) return false;
  if (typeof change.before !== 'string' || typeof change.after !== 'string') return false;
  if (!Number.isInteger(change.addedLines) || Number(change.addedLines) < 0) return false;
  if (!Number.isInteger(change.removedLines) || Number(change.removedLines) < 0) return false;
  if (change.type === 'renamed') return typeof change.renamedFrom === 'string' && Boolean(change.renamedFrom.trim());
  return change.renamedFrom === undefined;
}

function isSnapshot(value: unknown): value is ShadowWorkspaceSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<ShadowWorkspaceSnapshot>;
  return typeof snapshot.chatId === 'string'
    && Boolean(snapshot.chatId.trim())
    && typeof snapshot.runId === 'string'
    && Boolean(snapshot.runId.trim())
    && typeof snapshot.projectId === 'string'
    && Boolean(snapshot.projectId.trim())
    && isTimestamp(snapshot.createdAt)
    && isTimestamp(snapshot.updatedAt)
    && Number(snapshot.updatedAt) >= Number(snapshot.createdAt)
    && snapshot.status === 'active'
    && Array.isArray(snapshot.changes)
    && snapshot.changes.every(isFileDiff);
}

function cloneSnapshot(snapshot: ShadowWorkspaceSnapshot): ShadowWorkspaceSnapshot {
  return {
    chatId: snapshot.chatId,
    runId: snapshot.runId,
    projectId: snapshot.projectId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    status: snapshot.status,
    changes: snapshot.changes.map((change) => ({ ...change })),
  };
}

export class ExecutionShadowWorkspaceStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ShadowWorkspaceSnapshot[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, snapshots: [] });
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
    const value = stored as Partial<StoredShadowWorkspaces>;
    if (value.version !== 1 || !Array.isArray(value.snapshots)) return [];

    const byRun = new Map<string, ShadowWorkspaceSnapshot>();
    for (const candidate of value.snapshots) {
      if (!isSnapshot(candidate)) continue;
      const normalized = cloneSnapshot(candidate);
      normalized.chatId = normalized.chatId.trim();
      normalized.runId = normalized.runId.trim();
      normalized.projectId = normalized.projectId.trim();
      const key = `${normalized.chatId}\u0000${normalized.runId}`;
      const current = byRun.get(key);
      if (!current || normalized.updatedAt >= current.updatedAt) byRun.set(key, normalized);
    }

    return [...byRun.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.runId.localeCompare(right.runId))
      .map(cloneSnapshot);
  }

  async save(snapshots: ShadowWorkspaceSnapshot[]): Promise<void> {
    const safeSnapshots = snapshots.filter(isSnapshot).map(cloneSnapshot);
    await this.storage.write<StoredShadowWorkspaces>(this.fileName, { version: 1, snapshots: safeSnapshots });
  }
}

export class ExecutionShadowWorkspacePersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionShadowWorkspaceStore) {}

  schedule(snapshots: ShadowWorkspaceSnapshot[]): void {
    const copy = snapshots.filter(isSnapshot).map(cloneSnapshot);
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
