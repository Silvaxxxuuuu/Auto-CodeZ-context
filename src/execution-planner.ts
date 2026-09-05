import crypto from 'node:crypto';

export type ExecutionPlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ExecutionPlanStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ExecutionEvidenceType = 'tool' | 'test' | 'build' | 'file' | 'result';

export type ExecutionStepEvidence = {
  type: ExecutionEvidenceType;
  summary: string;
  reference?: string;
  createdAt: number;
};

export type ExecutionPlanStep = {
  id: string;
  title: string;
  status: ExecutionPlanStepStatus;
  createdAt: number;
  updatedAt: number;
  evidence: ExecutionStepEvidence[];
};

export type ExecutionPlan = {
  id: string;
  chatId: string;
  runId: string;
  objective: string;
  status: ExecutionPlanStatus;
  createdAt: number;
  updatedAt: number;
  steps: ExecutionPlanStep[];
};

export type ExecutionPlanChange =
  | { type: 'upsert'; plan: ExecutionPlan }
  | { type: 'remove'; chatId: string; runId: string; planId: string };

export type ExecutionPlanObserver = (change: ExecutionPlanChange) => void;

type PlannerOptions = {
  now?: () => number;
  createId?: () => string;
};

const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_STEP_TITLE_LENGTH = 1000;
const MAX_EVIDENCE_SUMMARY_LENGTH = 4000;
const MAX_REFERENCE_LENGTH = 4000;
const MAX_STEPS = 100;
const MAX_EVIDENCE_PER_STEP = 50;

function requireText(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} inválido.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} não pode ficar vazio.`);
  if (normalized.length > maxLength) throw new Error(`${label} excede o limite permitido.`);
  return normalized;
}

function cloneEvidence(evidence: ExecutionStepEvidence): ExecutionStepEvidence {
  return { ...evidence };
}

function cloneStep(step: ExecutionPlanStep): ExecutionPlanStep {
  return { ...step, evidence: step.evidence.map(cloneEvidence) };
}

function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return { ...plan, steps: plan.steps.map(cloneStep) };
}

function derivePlanStatus(steps: ExecutionPlanStep[]): ExecutionPlanStatus {
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.every((step) => step.status === 'completed' || step.status === 'skipped')) return 'completed';
  if (steps.some((step) => step.status !== 'pending')) return 'running';
  return 'pending';
}

export class ExecutionPlanner {
  private readonly plansByChat = new Map<string, ExecutionPlan>();
  private readonly observers = new Set<ExecutionPlanObserver>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: PlannerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  subscribe(observer: ExecutionPlanObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  create(chatId: string, runId: string, objective: string, stepTitles: string[]): ExecutionPlan {
    const normalizedChatId = requireText(chatId, 'Chat', 500);
    const normalizedRunId = requireText(runId, 'Execução', 500);
    const normalizedObjective = requireText(objective, 'Objetivo', MAX_OBJECTIVE_LENGTH);
    if (!Array.isArray(stepTitles) || stepTitles.length < 1) throw new Error('O plano precisa de pelo menos um passo.');
    if (stepTitles.length > MAX_STEPS) throw new Error('O plano excede o limite de passos.');

    const current = this.plansByChat.get(normalizedChatId);
    if (current && current.runId === normalizedRunId && current.status !== 'completed' && current.status !== 'failed') {
      throw new Error('Já existe um plano ativo para esta execução.');
    }

    const createdAt = this.now();
    const steps: ExecutionPlanStep[] = stepTitles.map((title) => ({
      id: this.createId(),
      title: requireText(title, 'Passo', MAX_STEP_TITLE_LENGTH),
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      evidence: [],
    }));
    const plan: ExecutionPlan = {
      id: this.createId(),
      chatId: normalizedChatId,
      runId: normalizedRunId,
      objective: normalizedObjective,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      steps,
    };
    this.plansByChat.set(normalizedChatId, plan);
    this.publish({ type: 'upsert', plan });
    return clonePlan(plan);
  }

  get(chatId: string, runId?: string): ExecutionPlan | undefined {
    const plan = this.plansByChat.get(chatId);
    if (!plan || (runId !== undefined && plan.runId !== runId)) return undefined;
    return clonePlan(plan);
  }

  list(): ExecutionPlan[] {
    return [...this.plansByChat.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clonePlan);
  }

  startStep(chatId: string, runId: string, stepId: string): ExecutionPlan {
    const { plan, step } = this.requireStep(chatId, runId, stepId);
    if (plan.status === 'completed' || plan.status === 'failed') throw new Error('O plano já está em estado terminal.');
    if (step.status !== 'pending') throw new Error('Somente um passo pendente pode ser iniciado.');
    if (plan.steps.some((item) => item.status === 'running')) throw new Error('Já existe um passo em execução.');

    const firstPending = plan.steps.find((item) => item.status === 'pending');
    if (firstPending?.id !== step.id) throw new Error('Os passos do plano devem ser executados em ordem.');
    return this.transition(plan, step, 'running');
  }

  completeStep(chatId: string, runId: string, stepId: string, evidence?: Omit<ExecutionStepEvidence, 'createdAt'>[]): ExecutionPlan {
    const { plan, step } = this.requireStep(chatId, runId, stepId);
    if (step.status !== 'running') throw new Error('Somente um passo em execução pode ser concluído.');
    this.appendEvidence(step, evidence);
    return this.transition(plan, step, 'completed');
  }

  failStep(chatId: string, runId: string, stepId: string, evidence?: Omit<ExecutionStepEvidence, 'createdAt'>[]): ExecutionPlan {
    const { plan, step } = this.requireStep(chatId, runId, stepId);
    if (step.status !== 'running') throw new Error('Somente um passo em execução pode falhar.');
    this.appendEvidence(step, evidence);
    return this.transition(plan, step, 'failed');
  }

  skipStep(chatId: string, runId: string, stepId: string, evidence?: Omit<ExecutionStepEvidence, 'createdAt'>[]): ExecutionPlan {
    const { plan, step } = this.requireStep(chatId, runId, stepId);
    if (plan.status === 'completed' || plan.status === 'failed') throw new Error('O plano já está em estado terminal.');
    if (step.status !== 'pending') throw new Error('Somente um passo pendente pode ser ignorado.');
    const firstPending = plan.steps.find((item) => item.status === 'pending');
    if (firstPending?.id !== step.id) throw new Error('Os passos do plano devem ser tratados em ordem.');
    this.appendEvidence(step, evidence);
    return this.transition(plan, step, 'skipped');
  }

  remove(chatId: string, runId?: string): boolean {
    const current = this.plansByChat.get(chatId);
    if (!current || (runId !== undefined && current.runId !== runId)) return false;
    this.plansByChat.delete(chatId);
    this.publish({ type: 'remove', chatId, runId: current.runId, planId: current.id });
    return true;
  }

  private requireStep(chatId: string, runId: string, stepId: string): { plan: ExecutionPlan; step: ExecutionPlanStep } {
    const plan = this.plansByChat.get(chatId);
    if (!plan || plan.runId !== runId) throw new Error('Plano da execução não encontrado.');
    const step = plan.steps.find((item) => item.id === stepId);
    if (!step) throw new Error('Passo do plano não encontrado.');
    return { plan, step };
  }

  private appendEvidence(step: ExecutionPlanStep, evidence?: Omit<ExecutionStepEvidence, 'createdAt'>[]): void {
    if (evidence === undefined) return;
    if (!Array.isArray(evidence)) throw new Error('Evidências do passo inválidas.');
    if (step.evidence.length + evidence.length > MAX_EVIDENCE_PER_STEP) throw new Error('O passo excede o limite de evidências.');
    for (const item of evidence) {
      if (!item || typeof item !== 'object') throw new Error('Evidência do passo inválida.');
      if (!['tool', 'test', 'build', 'file', 'result'].includes(item.type)) throw new Error('Tipo de evidência inválido.');
      const summary = requireText(item.summary, 'Resumo da evidência', MAX_EVIDENCE_SUMMARY_LENGTH);
      const reference = item.reference === undefined ? undefined : requireText(item.reference, 'Referência da evidência', MAX_REFERENCE_LENGTH);
      step.evidence.push({ type: item.type, summary, reference, createdAt: this.now() });
    }
  }

  private transition(plan: ExecutionPlan, step: ExecutionPlanStep, status: ExecutionPlanStepStatus): ExecutionPlan {
    const updatedAt = this.now();
    step.status = status;
    step.updatedAt = updatedAt;
    plan.updatedAt = updatedAt;
    plan.status = derivePlanStatus(plan.steps);
    this.publish({ type: 'upsert', plan });
    return clonePlan(plan);
  }

  private publish(change: ExecutionPlanChange): void {
    const safeChange: ExecutionPlanChange = change.type === 'upsert'
      ? { type: 'upsert', plan: clonePlan(change.plan) }
      : { ...change };
    for (const observer of this.observers) {
      try {
        observer(safeChange);
      } catch {}
    }
  }
}
