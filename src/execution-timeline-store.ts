import type { LocalStorage } from './core/storage';
import type { ExecutionTimelineEvent } from './execution-timeline';

const DEFAULT_FILE = 'execution-timeline.json';
const EVENT_TYPES = new Set<ExecutionTimelineEvent['type']>(['started', 'recovered', 'state_changed', 'tool_changed', 'error', 'removed']);
const STATES = new Set(['idle', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted']);

type StoredExecutionTimeline = {
  version: 1;
  events: ExecutionTimelineEvent[];
};

function isEvent(value: unknown): value is ExecutionTimelineEvent {
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
    && (event.state === undefined || STATES.has(event.state))
    && (event.startedAt === undefined || (typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0))
    && (event.currentTool === undefined || typeof event.currentTool === 'string')
    && (event.error === undefined || typeof event.error === 'string');
  if (!validBase) return false;
  if (event.type === 'recovered') return event.state !== undefined && event.startedAt !== undefined && event.startedAt <= event.at;
  return event.startedAt === undefined;
}

function cloneEvent(event: ExecutionTimelineEvent): ExecutionTimelineEvent {
  return { ...event };
}

export class ExecutionTimelineStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionTimelineEvent[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, events: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionTimeline>;
    if (value.version !== 1 || !Array.isArray(value.events)) return [];
    return value.events.filter(isEvent).map(cloneEvent);
  }

  async save(events: ExecutionTimelineEvent[]): Promise<void> {
    await this.storage.write<StoredExecutionTimeline>(this.fileName, {
      version: 1,
      events: events.filter(isEvent).map(cloneEvent),
    });
  }
}

export class ExecutionTimelinePersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionTimelineStore) {}

  schedule(events: ExecutionTimelineEvent[]): void {
    const copy = events.map(cloneEvent);
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
