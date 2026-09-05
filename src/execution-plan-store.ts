import type { LocalStorage } from './core/storage';
import type { ExecutionPlan } from './execution-planner';

const DEFAULT_FILE = 'execution-plans.json';

type StoredExecutionPlans = {
  version: 1;
  plans: ExecutionPlan[];
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

export class ExecutionPlanStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly fileName = DEFAULT_FILE,
  ) {}

  async load(): Promise<ExecutionPlan[]> {
    const stored = await this.storage.read<unknown>(this.fileName, { version: 1, plans: [] });
    if (!stored || typeof stored !== 'object') return [];
    const value = stored as Partial<StoredExecutionPlans>;
    if (value.version !== 1 || !Array.isArray(value.plans)) return [];
    return value.plans
      .filter((plan): plan is ExecutionPlan => Boolean(plan && typeof plan === 'object'))
      .map(clonePlan);
  }

  async save(plans: ExecutionPlan[]): Promise<void> {
    await this.storage.write<StoredExecutionPlans>(this.fileName, {
      version: 1,
      plans: plans.map(clonePlan),
    });
  }
}

export class ExecutionPlanPersistence {
  private pending: Promise<void> = Promise.resolve();
  private lastError: Error | undefined;

  constructor(private readonly store: ExecutionPlanStore) {}

  schedule(plans: ExecutionPlan[]): void {
    const copy = plans.map(clonePlan);
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
