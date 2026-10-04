import type { LocalStorage } from './core/storage';
import { normalizeExecutionScopePath, type ExecutionPathScopeSnapshot } from './execution-path-scope';

const DEFAULT_FILE = 'execution-path-scopes.json';

type StoredExecutionPathScopes = {
  version: 1;
  snapshots: ExecutionPathScopeSnapshot[];
};

function isSnapshot(value: unknown): value is ExecutionPathScopeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<ExecutionPathScopeSnapshot>;
  if (typeof snapshot.chatId !== 'string' || !snapshot.chatId.trim()) return false;
  if (typeof snapshot.runId !== 'string' || !snapshot.runId.trim()) return false;
  if (typeof snapshot.projectId !== 'string' || !snapshot.projectId.trim()) return false;
  if (!Array.isArray(snapshot.allowedPaths) || snapshot.allowedPaths.length === 0 || snapshot.allowedPaths.some((item) => typeof item !== 'string')) return false;
  if (typeof snapshot.configuredAt !== 'number' || !Number.isFinite(snapshot.configuredAt) || snapshot.configuredAt < 0) return false;
  try {
    snapshot.allowedPaths.forEach((item) => normalizeExecutionScopePath(item as string));
    return true;
  } catch {
    return false;
  }
}

function cloneSnapshot(snapshot: ExecutionPathScopeSnapshot): ExecutionPathScopeSnapshot {
  return { ...snapshot, allowedPaths: [...snapshot.allowedPaths] };
}

function normalizeSnapshot(snapshot: ExecutionPathScopeSnapshot): ExecutionPathScopeSnapshot {
  const allowedPaths = [...new Set(snapshot.allowedPaths.map(normalizeExecutionScopePath))].sort();
  return {
    chatId: snapshot.chatId.trim(),
    runId: snapshot.runId.trim(),
    projectId: snapshot.projectId.trim(),
    allowedPaths: allowedPaths.includes('.') ? ['.'] : allowedPaths,
    configuredAt: snapshot.configuredAt,
  };
}

export class ExecutionPathScopeStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionPathScopeSnapshot[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, snapshots: [] });
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
    const value = stored as Partial<StoredExecutionPathScopes>;
    if (value.version !== 1 || !Array.isArray(value.snapshots)) return [];

    const byRun = new Map<string, ExecutionPathScopeSnapshot>();
    for (const candidate of value.snapshots) {
      if (!isSnapshot(candidate)) continue;
      const normalized = normalizeSnapshot(candidate);
      const key = `${normalized.chatId}\u0000${normalized.runId}`;
      const current = byRun.get(key);
      if (!current || normalized.configuredAt >= current.configuredAt) byRun.set(key, normalized);
    }

    return [...byRun.values()]
      .sort((left, right) => right.configuredAt - left.configuredAt || left.runId.localeCompare(right.runId))
      .map(cloneSnapshot);
  }

  async save(snapshots: ExecutionPathScopeSnapshot[]): Promise<void> {
    const safeSnapshots = snapshots.filter(isSnapshot).map(normalizeSnapshot);
    await this.storage.write<StoredExecutionPathScopes>(this.fileName, { version: 1, snapshots: safeSnapshots });
  }
}

export class ExecutionPathScopePersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionPathScopeStore) {}

  schedule(snapshots: ExecutionPathScopeSnapshot[]): void {
    const copy = snapshots.map(cloneSnapshot);
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
