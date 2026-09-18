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
  private lastError: Error | undefined;

  constructor(private readonly store: OperationalLedgerStore) {}

  schedule(events: OperationalLedgerEvent[]): void {
    const snapshot = events.map(cloneEvent);
    this.pending = this.pending
      .catch((): void => {})
      .then(async (): Promise<void> => {
        try {
          await this.store.save(snapshot);
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
