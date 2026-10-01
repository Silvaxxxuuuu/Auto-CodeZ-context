import type { LocalStorage } from '../core/storage';
import type {
  OperationJournalRecord,
  OperationJournalResource,
  OperationJournalStatus,
  OperationSnapshot,
} from './contracts';
import { OperationJournalRuntime, type OperationAfterSnapshot, type PrepareOperationInput } from './operation-journal';

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
    && (snapshot.kind === undefined || snapshot.kind === 'file' || snapshot.kind === 'directory')
    && (snapshot.hash === undefined || (typeof snapshot.hash === 'string' && Boolean(snapshot.hash.trim())))
    && isOptionalFiniteNonNegative(snapshot.size)
    && isOptionalFiniteNonNegative(snapshot.modifiedAt)
    && (snapshot.contentRef === undefined || (typeof snapshot.contentRef === 'string' && Boolean(snapshot.contentRef.trim())));
}

function isResource(value: unknown): value is OperationJournalResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resource = value as Partial<OperationJournalResource>;
  return typeof resource.target === 'string'
    && Boolean(resource.target.trim())
    && isSnapshot(resource.before)
    && (resource.after === undefined || isSnapshot(resource.after))
    && (resource.rollbackRef === undefined || (typeof resource.rollbackRef === 'string' && Boolean(resource.rollbackRef.trim())));
}

export function isOperationJournalRecord(value: unknown): value is OperationJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<OperationJournalRecord>;
  if (record.contractVersion !== 1) return false;
  for (const key of ['operationId', 'runId', 'toolCallId', 'capabilityId', 'projectId', 'target'] as const) {
    if (typeof record[key] !== 'string' || !record[key]?.trim()) return false;
  }
  if (!Array.isArray(record.resources) || record.resources.length === 0 || record.resources.some((resource) => !isResource(resource))) return false;
  const resourceKeys = new Set<string>();
  for (const resource of record.resources) {
    const key = resource.target.toLowerCase();
    if (resourceKeys.has(key)) return false;
    resourceKeys.add(key);
  }
  if (!resourceKeys.has(record.target.toLowerCase())) return false;
  if (typeof record.status !== 'string' || !STATUSES.has(record.status as OperationJournalStatus)) return false;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0) return false;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) return false;
  if (record.verifiedAt !== undefined && (typeof record.verifiedAt !== 'number' || !Number.isFinite(record.verifiedAt) || record.verifiedAt < record.createdAt || record.verifiedAt > record.updatedAt)) return false;
  if (record.error !== undefined && (typeof record.error !== 'string' || !record.error.trim())) return false;

  const everyAfter = record.resources.every((resource) => resource.after !== undefined);
  const everyRollback = record.resources.every((resource) => Boolean(resource.rollbackRef));
  if (record.status === 'verified' && (!everyAfter || record.verifiedAt === undefined || record.error !== undefined)) return false;
  if (record.status === 'failed' && !record.error) return false;
  if (record.status === 'rolled_back' && (!everyAfter || !everyRollback || record.error !== undefined)) return false;
  if (record.status === 'rollback_conflict' && !record.error) return false;
  if ((record.status === 'prepared' || record.status === 'executing') && record.verifiedAt !== undefined) return false;

  return true;
}

function cloneSnapshot(snapshot: OperationSnapshot): OperationSnapshot {
  return { ...snapshot };
}

function cloneResource(resource: OperationJournalResource): OperationJournalResource {
  return {
    ...resource,
    before: cloneSnapshot(resource.before),
    ...(resource.after ? { after: cloneSnapshot(resource.after) } : {}),
  };
}

function cloneRecord(record: OperationJournalRecord): OperationJournalRecord {
  return { ...record, resources: record.resources.map(cloneResource) };
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

export class DurableOperationJournal {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runtime: OperationJournalRuntime,
    private readonly store: OperationJournalStore,
  ) {}

  async init(): Promise<void> {
    this.runtime.hydrate(await this.store.load());
  }

  list(filters: Parameters<OperationJournalRuntime['list']>[0] = {}): OperationJournalRecord[] {
    return this.runtime.list(filters);
  }

  get(operationId: string): OperationJournalRecord | undefined {
    return this.runtime.get(operationId);
  }

  prepare(input: PrepareOperationInput): Promise<OperationJournalRecord> {
    return this.transition(() => this.runtime.prepare(input));
  }

  start(operationId: string): Promise<OperationJournalRecord> {
    return this.transition(() => this.runtime.start(operationId));
  }

  verify(operationId: string, after: OperationAfterSnapshot[]): Promise<OperationJournalRecord> {
    return this.transition(() => this.runtime.verify(operationId, after));
  }

  fail(operationId: string, error: string, after: OperationAfterSnapshot[] = []): Promise<OperationJournalRecord> {
    return this.transition(() => this.runtime.fail(operationId, error, after));
  }

  markRolledBack(operationId: string, after: OperationAfterSnapshot[]): Promise<OperationJournalRecord> {
    return this.transition(() => this.runtime.markRolledBack(operationId, after));
  }

  markRollbackConflict(operationId: string, error: string, after: OperationAfterSnapshot[] = []): Promise<OperationJournalRecord> {
    return this.transition(() => this.runtime.markRollbackConflict(operationId, error, after));
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private transition<T extends OperationJournalRecord>(mutate: () => T): Promise<T> {
    const run = this.pending
      .catch((): void => {})
      .then(async (): Promise<T> => {
        const before = this.runtime.list();
        const result = mutate();
        try {
          await this.store.save(this.runtime.list());
          return result;
        } catch (error) {
          this.runtime.hydrate(before);
          throw error;
        }
      });
    this.pending = run;
    return run;
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
