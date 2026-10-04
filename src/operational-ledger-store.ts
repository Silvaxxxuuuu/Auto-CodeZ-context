import type { LocalStorage } from './core/storage';
import { isOperationalLedgerEvent, type OperationalLedgerEvent } from './operational-ledger';

const DEFAULT_FILE = 'operational-ledger.json';

type StoredOperationalLedger = {
  version: 1;
  events: OperationalLedgerEvent[];
};

function cloneEvent(event: OperationalLedgerEvent): OperationalLedgerEvent {
  return {
    ...event,
    ...(event.artifactIds ? { artifactIds: [...event.artifactIds] } : {}),
    ...(event.resources ? { resources: [...event.resources] } : {}),
    ...(event.sourceRefs ? { sourceRefs: [...event.sourceRefs] } : {}),
    ...(event.diff ? { diff: { ...event.diff } } : {}),
    ...(event.details ? { details: { ...event.details } } : {}),
  };
}

export class OperationalLedgerStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<OperationalLedgerEvent[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, events: [] });
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
    const value = stored as Partial<StoredOperationalLedger>;
    if (value.version !== 1 || !Array.isArray(value.events)) return [];
    return value.events.filter(isOperationalLedgerEvent).map(cloneEvent);
  }

  async save(events: OperationalLedgerEvent[]): Promise<void> {
    await this.storage.write<StoredOperationalLedger>(this.fileName, {
      version: 1,
      events: events.filter(isOperationalLedgerEvent).map(cloneEvent),
    });
  }
}

export class OperationalLedgerPersistence {
  private pending: Promise<void> = Promise.resolve();
  private queued: OperationalLedgerEvent[] | undefined;
  private draining = false;
  private lastError: Error | undefined;

  constructor(private readonly store: OperationalLedgerStore) {}

  schedule(events: OperationalLedgerEvent[]): void {
    this.queued = events.map(cloneEvent);
    if (this.draining) return;
    this.draining = true;
    this.pending = this.drain();
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.lastError) throw this.lastError;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queued) {
        const snapshot = this.queued;
        this.queued = undefined;
        try {
          await this.store.save(snapshot);
          this.lastError = undefined;
        } catch (error) {
          this.lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
    } finally {
      this.draining = false;
      if (this.queued) {
        this.draining = true;
        this.pending = this.drain();
      }
    }
  }
}
