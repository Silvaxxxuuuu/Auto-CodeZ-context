import type { ExecutionPlan, ExecutionPlanChange } from './execution-planner';

export type ExecutionPlanHistoryRecord = {
  chatId: string;
  runId: string;
  planId: string;
  plan: ExecutionPlan;
  firstSeenAt: number;
  lastSeenAt: number;
  removedAt?: number;
};

function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      evidence: step.evidence.map((evidence) => ({ ...evidence })),
    })),
  };
}

function cloneRecord(record: ExecutionPlanHistoryRecord): ExecutionPlanHistoryRecord {
  return { ...record, plan: clonePlan(record.plan) };
}

function keyOf(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function validRecord(record: ExecutionPlanHistoryRecord): boolean {
  return Boolean(
    record
    && typeof record.chatId === 'string' && record.chatId
    && typeof record.runId === 'string' && record.runId
    && typeof record.planId === 'string' && record.planId
    && record.plan && typeof record.plan === 'object'
    && record.plan.chatId === record.chatId
    && record.plan.runId === record.runId
    && record.plan.id === record.planId
    && Number.isFinite(record.firstSeenAt) && record.firstSeenAt >= 0
    && Number.isFinite(record.lastSeenAt) && record.lastSeenAt >= record.firstSeenAt
    && (record.removedAt === undefined || (Number.isFinite(record.removedAt) && record.removedAt >= record.firstSeenAt))
  );
}

export class ExecutionPlanHistory {
  private readonly records = new Map<string, ExecutionPlanHistoryRecord>();

  constructor(
    private readonly maxRecords = 200,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new Error('maxRecords deve ser um inteiro positivo.');
  }

  restore(records: ExecutionPlanHistoryRecord[]): void {
    if (!Array.isArray(records)) throw new Error('Histórico de planos persistido inválido.');
    this.records.clear();
    for (const candidate of records) {
      if (!validRecord(candidate)) continue;
      const key = keyOf(candidate.chatId, candidate.runId);
      const current = this.records.get(key);
      if (!current || candidate.lastSeenAt > current.lastSeenAt) this.records.set(key, cloneRecord(candidate));
    }
    this.trim();
  }

  record(change: ExecutionPlanChange): boolean {
    if (change.type === 'upsert') {
      const plan = clonePlan(change.plan);
      const key = keyOf(plan.chatId, plan.runId);
      const current = this.records.get(key);
      const firstSeenAt = current?.firstSeenAt ?? plan.createdAt;
      const next: ExecutionPlanHistoryRecord = {
        chatId: plan.chatId,
        runId: plan.runId,
        planId: plan.id,
        plan,
        firstSeenAt,
        lastSeenAt: Math.max(current?.lastSeenAt ?? firstSeenAt, plan.updatedAt),
      };
      if (current?.removedAt !== undefined) next.removedAt = current.removedAt;
      this.records.set(key, next);
      this.trim();
      return true;
    }

    const key = keyOf(change.chatId, change.runId);
    const current = this.records.get(key);
    if (!current || current.planId !== change.planId) return false;
    if (current.removedAt !== undefined) return false;
    current.removedAt = Math.max(this.now(), current.lastSeenAt);
    current.lastSeenAt = Math.max(current.lastSeenAt, current.removedAt);
    return true;
  }

  list(filters: { chatId?: string; runId?: string } = {}): ExecutionPlanHistoryRecord[] {
    return [...this.records.values()]
      .filter((record) => (filters.chatId === undefined || record.chatId === filters.chatId) && (filters.runId === undefined || record.runId === filters.runId))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.firstSeenAt - left.firstSeenAt)
      .map(cloneRecord);
  }

  purgeChat(chatId: string): number {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.chatId !== chatId) continue;
      this.records.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.records.clear();
  }

  private trim(): void {
    if (this.records.size <= this.maxRecords) return;
    const oldest = [...this.records.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, this.records.size - this.maxRecords);
    for (const [key] of oldest) this.records.delete(key);
  }
}
