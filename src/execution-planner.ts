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
const STEP_STATUSES = new Set<ExecutionPlanStepStatus>(['pending', 'running', 'completed', 'failed', 'skipped']);
const EVIDENCE_TYPES = new Set<ExecutionEvidenceType>(['tool', 'test', 'build', 'file', 'result']);

function requireText(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} inválido.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} não pode ficar vazio.`);
  if (normalized.length > maxLength) throw new Error(`${label} excede o limite permitido.`);
  return normalized;
}

function requireTimestamp(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} inválido.`);
  return value;
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

function normalizeRestoredPlan(candidate: ExecutionPlan): ExecutionPlan {
  if (!candidate || typeof candidate !== 'object') throw new Error('Plano persistido inválido.');
  const id = requireText(candidate.id, 'ID do plano', 500);
  const chatId = requireText(candidate.chatId, 'Chat', 500);
  const runId = requireText(candidate.runId, 'Execução', 500);
  const objective = requireText(candidate.objective, 'Objetivo', MAX_OBJECTIVE_LENGTH);
  const createdAt = requireTimestamp(candidate.createdAt, 'Data de criação do plano');
  const updatedAt = requireTimestamp(candidate.updatedAt, 'Data de atualização do plano');
  if (updatedAt < createdAt) throw new Error('Datas do plano persistido são inválidas.');
  if (!Array.isArray(candidate.steps) || candidate.steps.length < 1 || candidate.steps.length > MAX_STEPS) throw new Error('Passos do plano persistido são inválidos.');

  const ids = new Set<string>();
  let runningCount = 0;
  const steps = candidate.steps.map((candidateStep) => {
    if (!candidateStep || typeof candidateStep !== 'object') throw new Error('Passo persistido inválido.');
    const stepId = requireText(candidateStep.id, 'ID do passo', 500);
    if (ids.has(stepId)) throw new Error('O plano persistido possui IDs de passo duplicados.');
    ids.add(stepId);
    const title = requireText(candidateStep.title, 'Passo', MAX_STEP_TITLE_LENGTH);
    if (!STEP_STATUSES.has(candidateStep.status)) throw new Error('Estado de passo persistido inválido.');
    if (candidateStep.status === 'running') runningCount += 1;
    const stepCreatedAt = requireTimestamp(candidateStep.createdAt, 'Data de criação do passo');
    const stepUpdatedAt = requireTimestamp(candidateStep.updatedAt, 'Data de atualização do passo');
    if (stepUpdatedAt < stepCreatedAt) throw new Error('Datas do passo persistido são inválidas.');
    if (!Array.isArray(candidateStep.evidence) || candidateStep.evidence.length > MAX_EVIDENCE_PER_STEP) throw new Error('Evidências persistidas inválidas.');
    const evidence = candidateStep.evidence.map((item) => {
      if (!item || typeof item !== 'object' || !EVIDENCE_TYPES.has(item.type)) throw new Error('Evidência persistida inválida.');
      return {
        type: item.type,
        summary: requireText(item.summary, 'Resumo da evidência', MAX_EVIDENCE_SUMMARY_LENGTH),
        reference: item.reference === undefined ? undefined : requireText(item.reference, 'Referência da evidência', MAX_REFERENCE_LENGTH),
        createdAt: requireTimestamp(item.createdAt, 'Data da evidência'),
      };
    });
    return {
      id: stepId,
      title,
      status: candidateStep.status === 'running' ? 'pending' as const : candidateStep.status,
      createdAt: stepCreatedAt,
      updatedAt: stepUpdatedAt,
      evidence,
    };
  });

  if (runningCount > 1) throw new Error('O plano persistido possui mais de um passo em execução.');
  return {
    id,
    chatId,
    runId,
    objective,
    status: derivePlanStatus(steps),
    createdAt,
    updatedAt,
    steps,
  };
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
    const steps = stepTitles.map<ExecutionPlanStep>((title) => ({
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

  restore(plans: ExecutionPlan[]): void {
    if (!Array.isArray(plans)) throw new Error('Planos persistidos inválidos.');
    const byChat = new Map<string, ExecutionPlan>();
    for (const candidate of plans) {
      try {
        const normalized = normalizeRestoredPlan(candidate);
        const current = byChat.get(normalized.chatId);
        if (!current || normalized.updatedAt > current.updatedAt) byChat.set(normalized.chatId, normalized);
      } catch {}
    }
    this.plansByChat.clear();
    for (const plan of byChat.values()) this.plansByChat.set(plan.chatId, plan);
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
    if (plan.steps.some((item) => item.status === 'running')) throw new Error('Os passos do plano devem ser tratados em ordem; conclua o passo em execução antes de ignorar outro.');
    const firstPending = plan.steps.find((item) => item.status === 'pending');
    if (firstPending?.id !== step.id) throw new Error('Os passos do plano devem ser tratados em ordem.');
    this.appendEvidence(step, evidence);
    return this.transition(plan, step, 'skipped');
  }

  recordEvidence(chatId: string, runId: string, evidence: Omit<ExecutionStepEvidence, 'createdAt'>): ExecutionPlan {
    const plan = this.plansByChat.get(chatId);
    if (!plan || plan.runId !== runId) throw new Error('Plano da execução não encontrado.');
    if (plan.status === 'completed' || plan.status === 'failed') throw new Error('O plano já está em estado terminal.');
    const step = plan.steps.find((item) => item.status === 'running');
    if (!step) throw new Error('Nenhum passo do plano está em execução.');
    this.appendEvidence(step, [evidence]);
    const updatedAt = this.now();
    step.updatedAt = updatedAt;
    plan.updatedAt = updatedAt;
    this.publish({ type: 'upsert', plan });
    return clonePlan(plan);
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
      if (!EVIDENCE_TYPES.has(item.type)) throw new Error('Tipo de evidência inválido.');
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
