import type { LocalStorage } from './core/storage';
import type { ExecutionChangeBudget, ExecutionChangeBudgetSnapshot, ExecutionChangeUsage } from './execution-change-budget';

const DEFAULT_FILE = 'execution-change-budget.json';

type StoredExecutionChangeBudgets = {
  version: 1;
  snapshots: ExecutionChangeBudgetSnapshot[];
};

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isBudget(value: unknown): value is ExecutionChangeBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const budget = value as Partial<ExecutionChangeBudget>;
  return [budget.maxFiles, budget.maxChangedLines, budget.maxCommands, budget.maxToolCalls, budget.maxDurationMs]
    .every((limit) => limit === undefined || isNonNegativeInteger(limit));
}

function isUsage(value: unknown): value is ExecutionChangeUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as Partial<ExecutionChangeUsage>;
  return Array.isArray(usage.files)
    && usage.files.every((item) => typeof item === 'string' && Boolean(item.trim()))
    && isNonNegativeInteger(usage.changedLines)
    && isNonNegativeInteger(usage.commands)
    && isNonNegativeInteger(usage.toolCalls);
}

function staticUsageWithinBudget(snapshot: ExecutionChangeBudgetSnapshot): boolean {
  const uniqueFiles = new Set(snapshot.usage.files.map((item) => item.trim()));
  if (snapshot.budget.maxFiles !== undefined && uniqueFiles.size > snapshot.budget.maxFiles) return false;
  if (snapshot.budget.maxChangedLines !== undefined && snapshot.usage.changedLines > snapshot.budget.maxChangedLines) return false;
  if (snapshot.budget.maxCommands !== undefined && snapshot.usage.commands > snapshot.budget.maxCommands) return false;
  if (snapshot.budget.maxToolCalls !== undefined && snapshot.usage.toolCalls > snapshot.budget.maxToolCalls) return false;
  return true;
}

function isSnapshot(value: unknown): value is ExecutionChangeBudgetSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ExecutionChangeBudgetSnapshot>;
  return typeof snapshot.chatId === 'string'
    && Boolean(snapshot.chatId.trim())
    && typeof snapshot.runId === 'string'
    && Boolean(snapshot.runId.trim())
    && isBudget(snapshot.budget)
    && isUsage(snapshot.usage)
    && typeof snapshot.startedAt === 'number'
    && Number.isFinite(snapshot.startedAt)
    && snapshot.startedAt >= 0
    && staticUsageWithinBudget(snapshot as ExecutionChangeBudgetSnapshot);
}

function cloneSnapshot(snapshot: ExecutionChangeBudgetSnapshot): ExecutionChangeBudgetSnapshot {
  return {
    chatId: snapshot.chatId,
    runId: snapshot.runId,
    budget: { ...snapshot.budget },
    usage: { ...snapshot.usage, files: [...snapshot.usage.files] },
    startedAt: snapshot.startedAt,
  };
}

export class ExecutionChangeBudgetStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionChangeBudgetSnapshot[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, snapshots: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionChangeBudgets>;
    if (value.version !== 1 || !Array.isArray(value.snapshots)) return [];

    const byRun = new Map<string, ExecutionChangeBudgetSnapshot>();
    for (const candidate of value.snapshots) {
      if (!isSnapshot(candidate)) continue;
      const normalized = cloneSnapshot(candidate);
      normalized.chatId = normalized.chatId.trim();
      normalized.runId = normalized.runId.trim();
      normalized.usage.files = [...new Set(normalized.usage.files.map((item) => item.trim()))].sort();
      const key = `${normalized.chatId}\u0000${normalized.runId}`;
      const current = byRun.get(key);
      if (!current || normalized.startedAt >= current.startedAt) byRun.set(key, normalized);
    }

    return [...byRun.values()]
      .sort((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId))
      .map(cloneSnapshot);
  }

  async save(snapshots: ExecutionChangeBudgetSnapshot[]): Promise<void> {
    const safeSnapshots = snapshots.filter(isSnapshot).map(cloneSnapshot);
    await this.storage.write<StoredExecutionChangeBudgets>(this.fileName, { version: 1, snapshots: safeSnapshots });
  }
}

export class ExecutionChangeBudgetPersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionChangeBudgetStore) {}

  schedule(snapshots: ExecutionChangeBudgetSnapshot[]): void {
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
