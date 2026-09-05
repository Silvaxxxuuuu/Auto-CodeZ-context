import type { LocalStorage } from './core/storage';
import type { ExecutionQualityGate } from './execution-quality-gate';

const DEFAULT_FILE = 'execution-quality-gates.json';

type StoredExecutionQualityGates = {
  version: 1;
  gates: ExecutionQualityGate[];
};

function cloneGate(gate: ExecutionQualityGate): ExecutionQualityGate {
  return structuredClone(gate);
}

export class ExecutionQualityGateStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionQualityGate[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, gates: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionQualityGates>;
    if (value.version !== 1 || !Array.isArray(value.gates)) return [];
    return value.gates.filter((gate): gate is ExecutionQualityGate => Boolean(gate && typeof gate === 'object')).map(cloneGate);
  }

  async save(gates: ExecutionQualityGate[]): Promise<void> {
    await this.storage.write<StoredExecutionQualityGates>(this.fileName, {
      version: 1,
      gates: gates.map(cloneGate),
    });
  }
}

export class ExecutionQualityGatePersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionQualityGateStore) {}

  schedule(gates: ExecutionQualityGate[]): void {
    const copy = gates.map(cloneGate);
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
