import crypto from 'node:crypto';
import type { OperationJournalRecord, OperationJournalStatus, OperationSnapshot } from './contracts';

export type OperationJournalListener = (records: OperationJournalRecord[]) => void;

export type PrepareOperationInput = {
  operationId?: string;
  runId: string;
  toolCallId: string;
  capabilityId: string;
  projectId: string;
  target: string;
  before: OperationSnapshot;
  rollbackRef?: string;
};

type RuntimeOptions = {
  now?: () => number;
  createId?: () => string;
};

const mutableStatuses = new Set<OperationJournalStatus>(['prepared', 'executing', 'verified', 'failed']);

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
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

export class OperationJournalRuntime {
  private readonly records = new Map<string, OperationJournalRecord>();
  private readonly listeners = new Set<OperationJournalListener>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: RuntimeOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  subscribe(listener: OperationJournalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prepare(input: PrepareOperationInput): OperationJournalRecord {
    const operationId = requireText(input.operationId ?? this.createId(), 'Operation id');
    if (this.records.has(operationId)) throw new Error(`Operation Journal duplicado: ${operationId}.`);
    const createdAt = this.now();
    const record: OperationJournalRecord = {
      contractVersion: 1,
      operationId,
      runId: requireText(input.runId, 'Run id'),
      toolCallId: requireText(input.toolCallId, 'Tool call id'),
      capabilityId: requireText(input.capabilityId, 'Capability id'),
      projectId: requireText(input.projectId, 'Project id'),
      target: requireText(input.target, 'Target'),
      status: 'prepared',
      before: cloneSnapshot(input.before),
      ...(input.rollbackRef?.trim() ? { rollbackRef: input.rollbackRef.trim() } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    this.records.set(operationId, record);
    this.emit();
    return cloneRecord(record);
  }

  start(operationId: string): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['prepared']);
    record.status = 'executing';
    record.updatedAt = this.nextTimestamp(record.updatedAt);
    this.emit();
    return cloneRecord(record);
  }

  verify(operationId: string, after: OperationSnapshot): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['executing']);
    const timestamp = this.nextTimestamp(record.updatedAt);
    record.status = 'verified';
    record.after = cloneSnapshot(after);
    record.updatedAt = timestamp;
    record.verifiedAt = timestamp;
    delete record.error;
    this.emit();
    return cloneRecord(record);
  }

  fail(operationId: string, error: string, after?: OperationSnapshot): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['prepared', 'executing']);
    record.status = 'failed';
    record.error = requireText(error, 'Erro');
    if (after) record.after = cloneSnapshot(after);
    record.updatedAt = this.nextTimestamp(record.updatedAt);
    this.emit();
    return cloneRecord(record);
  }

  markRolledBack(operationId: string, after: OperationSnapshot): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['verified', 'failed']);
    if (!record.rollbackRef) throw new Error(`Operação ${record.operationId} não possui rollbackRef.`);
    record.status = 'rolled_back';
    record.after = cloneSnapshot(after);
    record.updatedAt = this.nextTimestamp(record.updatedAt);
    delete record.error;
    this.emit();
    return cloneRecord(record);
  }

  markRollbackConflict(operationId: string, error: string, after?: OperationSnapshot): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['verified', 'failed']);
    record.status = 'rollback_conflict';
    record.error = requireText(error, 'Conflito de rollback');
    if (after) record.after = cloneSnapshot(after);
    record.updatedAt = this.nextTimestamp(record.updatedAt);
    this.emit();
    return cloneRecord(record);
  }

  get(operationId: string): OperationJournalRecord | undefined {
    const record = this.records.get(operationId);
    return record ? cloneRecord(record) : undefined;
  }

  list(filters: { runId?: string; projectId?: string; status?: OperationJournalStatus } = {}): OperationJournalRecord[] {
    return [...this.records.values()]
      .filter((record) => !filters.runId || record.runId === filters.runId)
      .filter((record) => !filters.projectId || record.projectId === filters.projectId)
      .filter((record) => !filters.status || record.status === filters.status)
      .sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
      .map(cloneRecord);
  }

  hydrate(records: OperationJournalRecord[]): void {
    if (!Array.isArray(records)) throw new Error('Operation Journal persistido inválido.');
    const next = new Map<string, OperationJournalRecord>();
    for (const record of records) {
      if (next.has(record.operationId)) throw new Error(`Operation Journal duplicado: ${record.operationId}.`);
      next.set(record.operationId, cloneRecord(record));
    }
    this.records.clear();
    for (const [operationId, record] of next) this.records.set(operationId, record);
    this.emit();
  }

  private require(operationId: string): OperationJournalRecord {
    const id = requireText(operationId, 'Operation id');
    const record = this.records.get(id);
    if (!record) throw new Error(`Operação não encontrada no journal: ${id}.`);
    return record;
  }

  private assertStatus(record: OperationJournalRecord, allowed: OperationJournalStatus[]): void {
    if (allowed.includes(record.status) && mutableStatuses.has(record.status)) return;
    throw new Error(`Transição inválida do Operation Journal para ${record.operationId}: estado atual ${record.status}.`);
  }

  private nextTimestamp(previous: number): number {
    return Math.max(this.now(), previous);
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot.map(cloneRecord));
      } catch {
      }
    }
  }
}
