import crypto from 'node:crypto';
import type {
  OperationJournalRecord,
  OperationJournalResource,
  OperationJournalStatus,
  OperationSnapshot,
} from './contracts';

export type OperationJournalListener = (records: OperationJournalRecord[]) => void;

export type PrepareOperationInput = {
  operationId?: string;
  runId: string;
  toolCallId: string;
  capabilityId: string;
  projectId: string;
  target: string;
  resources: Array<{
    target: string;
    before: OperationSnapshot;
    rollbackRef?: string;
  }>;
};

export type OperationAfterSnapshot = {
  target: string;
  after: OperationSnapshot;
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

function cloneResource(resource: OperationJournalResource): OperationJournalResource {
  return {
    ...resource,
    before: cloneSnapshot(resource.before),
    ...(resource.after ? { after: cloneSnapshot(resource.after) } : {}),
  };
}

function cloneRecord(record: OperationJournalRecord): OperationJournalRecord {
  return {
    ...record,
    resources: record.resources.map(cloneResource),
  };
}

function normalizedResources(input: PrepareOperationInput['resources'], primaryTarget: string): OperationJournalResource[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Operation Journal precisa registrar pelo menos um recurso.');
  const seen = new Set<string>();
  const resources = input.map((resource): OperationJournalResource => {
    const target = requireText(resource.target, 'Target do recurso');
    const key = target.toLowerCase();
    if (seen.has(key)) throw new Error(`Recurso duplicado no Operation Journal: ${target}.`);
    seen.add(key);
    return {
      target,
      before: cloneSnapshot(resource.before),
      ...(resource.rollbackRef?.trim() ? { rollbackRef: resource.rollbackRef.trim() } : {}),
    };
  });
  if (!resources.some((resource) => resource.target.toLowerCase() === primaryTarget.toLowerCase())) {
    throw new Error('O target principal precisa constar nos recursos do Operation Journal.');
  }
  return resources;
}

function applyAfterSnapshots(
  record: OperationJournalRecord,
  snapshots: OperationAfterSnapshot[],
  requireAll: boolean,
): void {
  if (!Array.isArray(snapshots)) throw new Error('Snapshots posteriores inválidos.');
  const byTarget = new Map<string, OperationSnapshot>();
  for (const item of snapshots) {
    const target = requireText(item.target, 'Target posterior');
    const key = target.toLowerCase();
    if (byTarget.has(key)) throw new Error(`Snapshot posterior duplicado: ${target}.`);
    byTarget.set(key, cloneSnapshot(item.after));
  }
  if (requireAll && byTarget.size !== record.resources.length) {
    throw new Error('A verificação precisa informar o estado posterior de todos os recursos.');
  }
  for (const resource of record.resources) {
    const after = byTarget.get(resource.target.toLowerCase());
    if (after) resource.after = after;
    else if (requireAll) throw new Error(`Snapshot posterior ausente para ${resource.target}.`);
  }
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
    const target = requireText(input.target, 'Target');
    const createdAt = this.now();
    const record: OperationJournalRecord = {
      contractVersion: 1,
      operationId,
      runId: requireText(input.runId, 'Run id'),
      toolCallId: requireText(input.toolCallId, 'Tool call id'),
      capabilityId: requireText(input.capabilityId, 'Capability id'),
      projectId: requireText(input.projectId, 'Project id'),
      target,
      resources: normalizedResources(input.resources, target),
      status: 'prepared',
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

  verify(operationId: string, after: OperationAfterSnapshot[]): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['executing']);
    applyAfterSnapshots(record, after, true);
    const timestamp = this.nextTimestamp(record.updatedAt);
    record.status = 'verified';
    record.updatedAt = timestamp;
    record.verifiedAt = timestamp;
    delete record.error;
    this.emit();
    return cloneRecord(record);
  }

  fail(operationId: string, error: string, after: OperationAfterSnapshot[] = []): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['prepared', 'executing']);
    applyAfterSnapshots(record, after, false);
    record.status = 'failed';
    record.error = requireText(error, 'Erro');
    record.updatedAt = this.nextTimestamp(record.updatedAt);
    this.emit();
    return cloneRecord(record);
  }

  markRolledBack(operationId: string, after: OperationAfterSnapshot[]): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['verified', 'failed']);
    if (record.resources.some((resource) => !resource.rollbackRef)) {
      throw new Error(`Operação ${record.operationId} possui recurso sem rollbackRef.`);
    }
    applyAfterSnapshots(record, after, true);
    record.status = 'rolled_back';
    record.updatedAt = this.nextTimestamp(record.updatedAt);
    delete record.error;
    this.emit();
    return cloneRecord(record);
  }

  markRollbackConflict(operationId: string, error: string, after: OperationAfterSnapshot[] = []): OperationJournalRecord {
    const record = this.require(operationId);
    this.assertStatus(record, ['verified', 'failed']);
    applyAfterSnapshots(record, after, false);
    record.status = 'rollback_conflict';
    record.error = requireText(error, 'Conflito de rollback');
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
