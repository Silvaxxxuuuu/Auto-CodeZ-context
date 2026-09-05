import type { ExecutionChange, ExecutionSnapshot } from './execution-manager';

export type ExecutionTimelineEvent = {
  sequence: number;
  chatId: string;
  runId: string;
  at: number;
  type: 'started' | 'state_changed' | 'tool_changed' | 'error' | 'removed';
  state?: ExecutionSnapshot['state'];
  currentTool?: string;
  error?: string;
};

type TimelineCursor = {
  snapshot: ExecutionSnapshot;
  signature: string;
};

function snapshotSignature(snapshot: ExecutionSnapshot): string {
  return JSON.stringify([
    snapshot.runId,
    snapshot.state,
    snapshot.updatedAt,
    snapshot.currentTool ?? null,
    snapshot.error ?? null,
  ]);
}

export class ExecutionTimeline {
  private sequence = 0;
  private readonly events: ExecutionTimelineEvent[] = [];
  private readonly cursors = new Map<string, TimelineCursor>();

  constructor(private readonly maxEvents = 1000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error('maxEvents deve ser um inteiro positivo.');
  }

  record(change: ExecutionChange): ExecutionTimelineEvent[] {
    if (change.type === 'remove') return this.recordRemoval(change.chatId, change.runId);
    return this.recordSnapshot(change.snapshot);
  }

  list(chatId?: string, runId?: string): ExecutionTimelineEvent[] {
    return this.events
      .filter((event) => (chatId === undefined || event.chatId === chatId) && (runId === undefined || event.runId === runId))
      .map((event) => ({ ...event }));
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
      at: Math.max(Date.now(), current.snapshot.updatedAt),
      type: 'removed',
      state: current.snapshot.state,
    })];
  }

  private append(event: Omit<ExecutionTimelineEvent, 'sequence'>): ExecutionTimelineEvent {
    const stored: ExecutionTimelineEvent = { sequence: ++this.sequence, ...event };
    this.events.push(stored);
    while (this.events.length > this.maxEvents) this.events.shift();
    return { ...stored };
  }
}
