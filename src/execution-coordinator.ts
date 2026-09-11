import type { ExecutionManager, ExecutionSnapshot } from './execution-manager';
import type { ExecutionPlan, ExecutionPlanner } from './execution-planner';

export type ExecutionCompletion = {
  execution: ExecutionSnapshot;
  plan?: ExecutionPlan;
  error?: string;
};

export type ExecutionCompletionPreflight = {
  allowed: boolean;
  plan?: ExecutionPlan;
  error?: string;
};

const INCOMPLETE_PLAN_ERROR = 'A execução terminou antes de concluir o plano declarado.';

export class ExecutionCoordinator {
  constructor(
    private readonly executions: ExecutionManager,
    private readonly planner: ExecutionPlanner,
  ) {}

  resumePlan(chatId: string, runId: string): ExecutionPlan | undefined {
    let plan = this.planner.get(chatId, runId);
    if (!plan || plan.status === 'completed' || plan.status === 'failed') return plan;
    if (plan.steps.some((step) => step.status === 'running')) return plan;
    const next = plan.steps.find((step) => step.status === 'pending');
    if (!next) return plan;
    plan = this.planner.startStep(chatId, runId, next.id);
    return plan;
  }

  waitingApproval(chatId: string, runId: string): ExecutionCompletion {
    return {
      execution: this.executions.update(chatId, { state: 'waiting_approval', runId }),
      plan: this.planner.get(chatId, runId),
    };
  }

  completionPreflight(chatId: string, runId: string): ExecutionCompletionPreflight {
    const plan = this.planner.get(chatId, runId);
    if (!plan || plan.status === 'completed') return { allowed: true, ...(plan ? { plan } : {}) };
    if (plan.status === 'failed') return { allowed: false, plan, error: 'O plano declarado terminou com falha.' };
    return { allowed: false, plan, error: INCOMPLETE_PLAN_ERROR };
  }

  complete(chatId: string, runId: string): ExecutionCompletion {
    const preflight = this.completionPreflight(chatId, runId);
    if (preflight.allowed) {
      return {
        execution: this.executions.update(chatId, { state: 'completed', runId }),
        ...(preflight.plan ? { plan: preflight.plan } : {}),
      };
    }
    if (preflight.plan?.status === 'failed') {
      const error = preflight.error as string;
      return { execution: this.executions.update(chatId, { state: 'failed', error, runId }), plan: preflight.plan, error };
    }

    const failedPlan = this.failPlan(chatId, runId, preflight.error as string) ?? preflight.plan;
    return {
      execution: this.executions.update(chatId, { state: 'failed', error: preflight.error, runId }),
      ...(failedPlan ? { plan: failedPlan } : {}),
      error: preflight.error,
    };
  }

  fail(chatId: string, runId: string, error: string): ExecutionCompletion {
    const message = typeof error === 'string' && error.trim() ? error.trim() : 'A execução falhou.';
    const current = this.executions.get(chatId);
    if (current?.runId === runId && current.state === 'interrupted') {
      return {
        execution: current,
        plan: this.planner.get(chatId, runId),
        error: message,
      };
    }
    const plan = this.failPlan(chatId, runId, message);
    return {
      execution: this.executions.update(chatId, { state: 'failed', error: message, runId }),
      plan,
      error: message,
    };
  }

  interrupt(chatId: string, runId: string): ExecutionSnapshot | undefined {
    this.planner.remove(chatId, runId);
    const current = this.executions.get(chatId);
    if (!current || current.runId !== runId) return current;
    if (current.state === 'running' || current.state === 'waiting_approval') {
      return this.executions.update(chatId, { state: 'interrupted', runId });
    }
    return current;
  }

  private failPlan(chatId: string, runId: string, summary: string): ExecutionPlan | undefined {
    let plan = this.planner.get(chatId, runId);
    if (!plan || plan.status === 'completed' || plan.status === 'failed') return plan;

    let step = plan.steps.find((item) => item.status === 'running');
    if (!step) {
      const pending = plan.steps.find((item) => item.status === 'pending');
      if (pending) {
        plan = this.planner.startStep(chatId, runId, pending.id);
        step = plan.steps.find((item) => item.status === 'running');
      }
    }
    if (!step) return plan;

    return this.planner.failStep(chatId, runId, step.id, [{
      type: 'result',
      summary,
      reference: runId,
    }]);
  }
}
