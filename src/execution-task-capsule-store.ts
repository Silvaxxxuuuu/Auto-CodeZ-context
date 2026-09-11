import type { LocalStorage } from './core/storage';
import type { ExecutionTaskCapsule } from './execution-task-capsule';

const DEFAULT_FILE = 'execution-task-capsules.json';

type StoredExecutionTaskCapsules = {
  version: 1;
  capsules: ExecutionTaskCapsule[];
};

function cloneCapsule(capsule: ExecutionTaskCapsule): ExecutionTaskCapsule {
  return { ...capsule };
}

export class ExecutionTaskCapsuleStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionTaskCapsule[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, capsules: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionTaskCapsules>;
    if (value.version !== 1 || !Array.isArray(value.capsules)) return [];
    return value.capsules.filter((capsule): capsule is ExecutionTaskCapsule => Boolean(capsule && typeof capsule === 'object')).map(cloneCapsule);
  }

  async save(capsules: ExecutionTaskCapsule[]): Promise<void> {
    await this.storage.write<StoredExecutionTaskCapsules>(this.fileName, {
      version: 1,
      capsules: capsules.map(cloneCapsule),
    });
  }
}

export class ExecutionTaskCapsulePersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionTaskCapsuleStore) {}

  schedule(capsules: ExecutionTaskCapsule[]): void {
    const copy = capsules.map(cloneCapsule);
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
