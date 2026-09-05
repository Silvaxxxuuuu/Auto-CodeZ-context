import type { LocalStorage } from './core/storage';
import type { ExecutionSnapshot, ExecutionState } from './execution-manager';

const DEFAULT_FILE = 'execution-state.json';
const STATES = new Set<ExecutionState>(['idle', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted']);

type StoredExecutionState = {
  version: 1;
  snapshots: ExecutionSnapshot[];
};

function isSnapshot(value: unknown): value is ExecutionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ExecutionSnapshot>;
  return typeof snapshot.chatId === 'string'
    && snapshot.chatId.length > 0
    && typeof snapshot.runId === 'string'
    && snapshot.runId.length > 0
    && typeof snapshot.state === 'string'
    && STATES.has(snapshot.state as ExecutionState)
    && typeof snapshot.startedAt === 'number'
    && Number.isFinite(snapshot.startedAt)
    && typeof snapshot.updatedAt === 'number'
    && Number.isFinite(snapshot.updatedAt)
    && snapshot.updatedAt >= snapshot.startedAt
    && (snapshot.currentTool === undefined || typeof snapshot.currentTool === 'string')
    && (snapshot.error === undefined || typeof snapshot.error === 'string');
}

function normalizeLoadedSnapshot(snapshot: ExecutionSnapshot): ExecutionSnapshot {
  if (snapshot.state !== 'running' && snapshot.state !== 'waiting_approval') return { ...snapshot };
  return {
    ...snapshot,
    state: 'interrupted',
    currentTool: undefined,
    error: undefined,
  };
}

export class ExecutionStateStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionSnapshot[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, snapshots: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionState>;
    if (value.version !== 1 || !Array.isArray(value.snapshots)) return [];

    const byChat = new Map<string, ExecutionSnapshot>();
    for (const candidate of value.snapshots) {
      if (!isSnapshot(candidate)) continue;
      const normalized = normalizeLoadedSnapshot(candidate);
      const current = byChat.get(normalized.chatId);
      if (!current || normalized.updatedAt > current.updatedAt) byChat.set(normalized.chatId, normalized);
    }
    return [...byChat.values()].map((snapshot) => ({ ...snapshot }));
  }

  async save(snapshots: ExecutionSnapshot[]): Promise<void> {
    const safeSnapshots = snapshots
      .filter(isSnapshot)
      .map((snapshot) => ({ ...snapshot }));
    await this.storage.write<StoredExecutionState>(this.fileName, { version: 1, snapshots: safeSnapshots });
  }
}

export class ExecutionStatePersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionStateStore) {}

  schedule(snapshots: ExecutionSnapshot[]): void {
    const copy = snapshots.map((snapshot) => ({ ...snapshot }));
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
