import type { LocalStorage } from './core/storage';
import type { ExecutionPlanHistoryRecord } from './execution-plan-history';

const DEFAULT_FILE = 'execution-plan-history.json';

type StoredExecutionPlanHistory = {
  version: 1;
  records: ExecutionPlanHistoryRecord[];
};

function cloneRecord(record: ExecutionPlanHistoryRecord): ExecutionPlanHistoryRecord {
  return structuredClone(record);
}

export class ExecutionPlanHistoryStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionPlanHistoryRecord[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, records: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionPlanHistory>;
    if (value.version !== 1 || !Array.isArray(value.records)) return [];
    return value.records
      .filter((record): record is ExecutionPlanHistoryRecord => Boolean(record && typeof record === 'object'))
      .map(cloneRecord);
  }

  async save(records: ExecutionPlanHistoryRecord[]): Promise<void> {
    await this.storage.write<StoredExecutionPlanHistory>(this.fileName, {
      version: 1,
      records: records.map(cloneRecord),
    });
  }
}

export class ExecutionPlanHistoryPersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionPlanHistoryStore) {}

  schedule(records: ExecutionPlanHistoryRecord[]): void {
    const copy = records.map(cloneRecord);
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
