import type { ExecutionChange, ExecutionSnapshot, ExecutionState } from './execution-manager';

export type ExecutionTimelineEvent = {
  sequence: number;
  chatId: string;
  runId: string;
  at: number;
  type: 'started' | 'recovered' | 'state_changed' | 'tool_changed' | 'error' | 'removed';
  state?: ExecutionSnapshot['state'];
  startedAt?: number;
  currentTool?: string;
  error?: string;
};

type TimelineCursor = {
  snapshot: ExecutionSnapshot;
  signature: string;
};

const EVENT_TYPES = new Set<ExecutionTimelineEvent['type']>(['started', 'recovered', 'state_changed', 'tool_changed', 'error', 'removed']);
const EXECUTION_STATES = new Set<ExecutionState>(['idle', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted']);

function snapshotSignature(snapshot: ExecutionSnapshot): string {
  return JSON.stringify([
    snapshot.runId,
    snapshot.state,
    snapshot.updatedAt,
    snapshot.currentTool ?? null,
    snapshot.error ?? null,
  ]);
}

function sameObservableState(left: ExecutionSnapshot, right: ExecutionSnapshot): boolean {
  return left.runId === right.runId
    && left.state === right.state
    && left.startedAt === right.startedAt
    && left.currentTool === right.currentTool
    && left.error === right.error;
}

function cloneEvent(event: ExecutionTimelineEvent): ExecutionTimelineEvent {
  return { ...event };
}

function isValidEvent(value: unknown): value is ExecutionTimelineEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<ExecutionTimelineEvent>;
  const validBase = Number.isInteger(event.sequence)
    && Number(event.sequence) > 0
    && typeof event.chatId === 'string'
    && event.chatId.length > 0
    && typeof event.runId === 'string'
    && event.runId.length > 0
    && typeof event.at === 'number'
    && Number.isFinite(event.at)
    && event.at >= 0
    && typeof event.type === 'string'
    && EVENT_TYPES.has(event.type as ExecutionTimelineEvent['type'])
    && (event.state === undefined || EXECUTION_STATES.has(event.state))
    && (event.startedAt === undefined || (typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0))
    && (event.currentTool === undefined || typeof event.currentTool === 'string')
    && (event.error === undefined || typeof event.error === 'string');
  if (!validBase) return false;
  if (event.type === 'recovered') return event.state !== undefined && event.startedAt !== undefined && event.startedAt <= event.at;
  return event.startedAt === undefined;
}

export class ExecutionTimeline {
  private sequence = 0;
  private readonly events: ExecutionTimelineEvent[] = [];
  private readonly cursors = new Map<string, TimelineCursor>();

  constructor(
    private readonly maxEvents = 1000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents deve ser um inteiro positivo.');
  }

  restore(events: ExecutionTimelineEvent[]): void {
    if (!Array.isArray(events)) throw new Error('Timeline persistida inválida.');
    const normalized = events
      .filter(isValidEvent)
      .sort((left, right) => left.sequence - right.sequence)
      .filter((event, index, list) => index === 0 || event.sequence !== list[index - 1].sequence)
      .slice(-this.maxEvents)
      .map(cloneEvent);

    this.events.length = 0;
    this.events.push(...normalized);
    this.sequence = normalized.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    this.rebuildCursors();
  }

  record(change: ExecutionChange): ExecutionTimelineEvent[] {
    if (change.type === 'remove') return this.recordRemoval(change.chatId, change.runId);
    return this.recordSnapshot(change.snapshot);
  }

  recordRecovery(snapshot: ExecutionSnapshot, at = this.now()): ExecutionTimelineEvent[] {
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) throw new Error('Data de recuperação inválida.');
    const current = this.cursors.get(snapshot.chatId);
    if (current && sameObservableState(current.snapshot, snapshot)) return [];

    const recoveredAt = Math.max(at, snapshot.updatedAt, snapshot.startedAt);
    const recoveredSnapshot: ExecutionSnapshot = { ...snapshot, updatedAt: recoveredAt };
    const event = this.append({
      chatId: snapshot.chatId,
      runId: snapshot.runId,
      at: recoveredAt,
      type: 'recovered',
      state: snapshot.state,
      startedAt: snapshot.startedAt,
      currentTool: snapshot.currentTool,
      error: snapshot.error,
    });
    this.cursors.set(snapshot.chatId, { snapshot: recoveredSnapshot, signature: snapshotSignature(recoveredSnapshot) });
    return [event];
  }

  list(chatId?: string, runId?: string): ExecutionTimelineEvent[] {
    return this.events
      .filter((event) => (chatId === undefined || event.chatId === chatId) && (runId === undefined || event.runId === runId))
      .map(cloneEvent);
  }

  clear(chatId?: string): void {
    if (chatId === undefined) {
      this.events.length = 0;
      this.cursors.clear();
      return;
    }
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index].chatId === chatId) this.events.splice(index, 1);
    }
    this.cursors.delete(chatId);
  }

  private recordSnapshot(snapshot: ExecutionSnapshot): ExecutionTimelineEvent[] {
    const current = this.cursors.get(snapshot.chatId);
    if (current && current.snapshot.runId === snapshot.runId && snapshot.updatedAt < current.snapshot.updatedAt) return [];

    const signature = snapshotSignature(snapshot);
    if (current?.signature === signature) return [];

    if (!current || current.snapshot.runId !== snapshot.runId) {
      this.cursors.set(snapshot.chatId, { snapshot: { ...snapshot }, signature });
      return [this.append({
        chatId: snapshot.chatId,
        runId: snapshot.runId,
        at: snapshot.startedAt,
        type: 'started',
        state: snapshot.state,
        currentTool: snapshot.currentTool,
        error: snapshot.error,
      })];
    }

    const emitted: ExecutionTimelineEvent[] = [];
    if (snapshot.state !== current.snapshot.state) {
      emitted.push(this.append({
        chatId: snapshot.chatId,
        runId: snapshot.runId,
        at: snapshot.updatedAt,
        type: 'state_changed',
        state: snapshot.state,
      }));
    }
    if (snapshot.currentTool !== current.snapshot.currentTool) {
      emitted.push(this.append({
        chatId: snapshot.chatId,
        runId: snapshot.runId,
        at: snapshot.updatedAt,
        type: 'tool_changed',
        state: snapshot.state,
        currentTool: snapshot.currentTool,
      }));
    }
    if (snapshot.error && snapshot.error !== current.snapshot.error) {
      emitted.push(this.append({
        chatId: snapshot.chatId,
        runId: snapshot.runId,
        at: snapshot.updatedAt,
        type: 'error',
        state: snapshot.state,
        error: snapshot.error,
      }));
    }

    this.cursors.set(snapshot.chatId, { snapshot: { ...snapshot }, signature });
    return emitted;
  }

  private recordRemoval(chatId: string, runId?: string): ExecutionTimelineEvent[] {
    const current = this.cursors.get(chatId);
    if (!current) return [];
    if (runId !== undefined && runId !== current.snapshot.runId) return [];
    this.cursors.delete(chatId);
    return [this.append({
      chatId,
      runId: current.snapshot.runId,
      at: Math.max(this.now(), current.snapshot.updatedAt),
      type: 'removed',
      state: current.snapshot.state,
    })];
  }

  private append(event: Omit<ExecutionTimelineEvent, 'sequence'>): ExecutionTimelineEvent {
    const stored: ExecutionTimelineEvent = { sequence: ++this.sequence, ...event };
    this.events.push(stored);
    while (this.events.length > this.maxEvents) this.events.shift();
    return cloneEvent(stored);
  }

  private rebuildCursors(): void {
    this.cursors.clear();
    for (const event of this.events) {
      if (event.type === 'removed') {
        const current = this.cursors.get(event.chatId);
        if (current?.snapshot.runId === event.runId) this.cursors.delete(event.chatId);
        continue;
      }

      const current = this.cursors.get(event.chatId);
      if (event.type === 'recovered') {
        if (!event.state || event.startedAt === undefined) continue;
        const snapshot: ExecutionSnapshot = {
          chatId: event.chatId,
          runId: event.runId,
          state: event.state,
          startedAt: event.startedAt,
          updatedAt: event.at,
          currentTool: event.currentTool,
          error: event.error,
        };
        this.cursors.set(event.chatId, { snapshot, signature: snapshotSignature(snapshot) });
        continue;
      }
      if (event.type === 'started' || !current || current.snapshot.runId !== event.runId) {
        if (event.type !== 'started' || !event.state) continue;
        const snapshot: ExecutionSnapshot = {
          chatId: event.chatId,
          runId: event.runId,
          state: event.state,
          startedAt: event.at,
          updatedAt: event.at,
          currentTool: event.currentTool,
          error: event.error,
        };
        this.cursors.set(event.chatId, { snapshot, signature: snapshotSignature(snapshot) });
        continue;
      }

      const snapshot: ExecutionSnapshot = { ...current.snapshot, updatedAt: event.at };
      if (event.type === 'state_changed' && event.state) snapshot.state = event.state;
      if (event.type === 'tool_changed') snapshot.currentTool = event.currentTool;
      if (event.type === 'error') snapshot.error = event.error;
      this.cursors.set(event.chatId, { snapshot, signature: snapshotSignature(snapshot) });
    }
  }
}
