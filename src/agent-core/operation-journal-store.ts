import type { LocalStorage } from '../core/storage';
import type { OperationJournalRecord, OperationJournalStatus, OperationSnapshot } from './contracts';

const DEFAULT_FILE = 'agent-core-operation-journal.json';
const STATUSES = new Set<OperationJournalStatus>([
  'prepared',
  'executing',
  'verified',
  'failed',
  'rolled_back',
  'rollback_conflict',
]);

type StoredOperationJournal = {
  version: 1;
  records: OperationJournalRecord[];
};

function isOptionalFiniteNonNegative(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isSnapshot(value: unknown): value is OperationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<OperationSnapshot>;
  return typeof snapshot.exists === 'boolean'
    && (snapshot.hash === undefined || (typeof snapshot.hash === 'string' && Boolean(snapshot.hash.trim())))
    && isOptionalFiniteNonNegative(snapshot.size)
    && isOptionalFiniteNonNegative(snapshot.modifiedAt)
    && (snapshot.contentRef === undefined || (typeof snapshot.contentRef === 'string' && Boolean(snapshot.contentRef.trim())));
}

export function isOperationJournalRecord(value: unknown): value is OperationJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<OperationJournalRecord>;
  if (record.contractVersion !== 1) return false;
  for (const key of ['operationId', 'runId', 'toolCallId', 'capabilityId', 'projectId', 'target'] as const) {
    if (typeof record[key] !== 'string' || !record[key]?.trim()) return false;
  }
  if (typeof record.status !== 'string' || !STATUSES.has(record.status as OperationJournalStatus)) return false;
  if (!isSnapshot(record.before)) return false;
  if (record.after !== undefined && !isSnapshot(record.after)) return false;
  if (record.rollbackRef !== undefined && (typeof record.rollbackRef !== 'string' || !record.rollbackRef.trim())) return false;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0) return false;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) return false;
  if (record.verifiedAt !== undefined && (typeof record.verifiedAt !== 'number' || !Number.isFinite(record.verifiedAt) || record.verifiedAt < record.createdAt || record.verifiedAt > record.updatedAt)) return false;
  if (record.error !== undefined && (typeof record.error !== 'string' || !record.error.trim())) return false;

  if (record.status === 'verified' && (!record.after || record.verifiedAt === undefined || record.error !== undefined)) return false;
  if (record.status === 'failed' && !record.error) return false;
  if (record.status === 'rolled_back' && (!record.after || !record.rollbackRef || record.error !== undefined)) return false;
  if (record.status === 'rollback_conflict' && !record.error) return false;
  if ((record.status === 'prepared' || record.status === 'executing') && record.verifiedAt !== undefined) return false;

  return true;
}

function cloneSnapshot(snapshot: OperationSnapshot): OperationSnapshot {
  return { ...snapshot };
}

function cloneRecord(record: OperationJournalRecord): OperationJournalRecord {
  return {
    ...record,
    before: cloneSnapshot(record.before),
    ...(record.after ? { after: cloneSnapshot(record.after) } : {}),
  };
}

export class OperationJournalStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<OperationJournalRecord[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, records: [] });
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
    const value = stored as Partial<StoredOperationJournal>;
    if (value.version !== 1 || !Array.isArray(value.records)) return [];

    const byId = new Map<string, OperationJournalRecord>();
    for (const candidate of value.records) {
      if (!isOperationJournalRecord(candidate)) continue;
      const current = byId.get(candidate.operationId);
      if (!current || candidate.updatedAt >= current.updatedAt) byId.set(candidate.operationId, cloneRecord(candidate));
    }

    return [...byId.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
      .map(cloneRecord);
  }

  async save(records: OperationJournalRecord[]): Promise<void> {
    const safeRecords = records.filter(isOperationJournalRecord).map(cloneRecord);
    await this.storage.write<StoredOperationJournal>(this.fileName, { version: 1, records: safeRecords });
  }
}

export class OperationJournalPersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: OperationJournalStore) {}

  schedule(records: OperationJournalRecord[]): void {
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
