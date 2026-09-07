import type { ExecutionEvidenceType } from './execution-planner';
import type { ExecutionReport } from './execution-report';

export type ExecutionQualityGateRequirement = {
  type: ExecutionEvidenceType;
  minimum: number;
  label?: string;
};

export type ExecutionQualityGate = {
  id: string;
  chatId: string;
  runId: string;
  requireVerifiedCompletion: boolean;
  requirements: ExecutionQualityGateRequirement[];
  createdAt: number;
};

export type ExecutionQualityGateStatus = 'not_configured' | 'pending' | 'passed' | 'failed';

export type ExecutionQualityGateCheck = {
  type: 'verified_completion' | ExecutionEvidenceType;
  label: string;
  required: number;
  actual: number;
  passed: boolean;
};

export type ExecutionQualityGateEvaluation = {
  chatId: string;
  runId: string;
  gate?: ExecutionQualityGate;
  status: ExecutionQualityGateStatus;
  checks: ExecutionQualityGateCheck[];
  reason?: string;
};

function cloneGate(gate: ExecutionQualityGate): ExecutionQualityGate {
  return { ...gate, requirements: gate.requirements.map((requirement) => ({ ...requirement })) };
}

function keyOf(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function normalizeRequirements(requirements: ExecutionQualityGateRequirement[]): ExecutionQualityGateRequirement[] {
  if (!Array.isArray(requirements)) throw new Error('Requisitos do quality gate inválidos.');
  const merged = new Map<ExecutionEvidenceType, ExecutionQualityGateRequirement>();
  for (const requirement of requirements) {
    if (!requirement || !['tool', 'test', 'build', 'file', 'result'].includes(requirement.type)) throw new Error('Tipo de evidência inválido no quality gate.');
    if (!Number.isInteger(requirement.minimum) || requirement.minimum < 1) throw new Error('Quantidade mínima de evidências deve ser um inteiro positivo.');
    const label = typeof requirement.label === 'string' && requirement.label.trim() ? requirement.label.trim() : undefined;
    const current = merged.get(requirement.type);
    if (!current || requirement.minimum > current.minimum) merged.set(requirement.type, { type: requirement.type, minimum: requirement.minimum, label });
  }
  return [...merged.values()];
}

function sameGate(left: ExecutionQualityGate, right: ExecutionQualityGate): boolean {
  return left.chatId === right.chatId
    && left.runId === right.runId
    && left.requireVerifiedCompletion === right.requireVerifiedCompletion
    && JSON.stringify(left.requirements) === JSON.stringify(right.requirements);
}

export class ExecutionQualityGateRuntime {
  private readonly gates = new Map<string, ExecutionQualityGate>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => `gate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  ) {}

  configure(input: {
    chatId: string;
    runId: string;
    requireVerifiedCompletion?: boolean;
    requirements?: ExecutionQualityGateRequirement[];
  }): ExecutionQualityGate {
    const chatId = requireId(input.chatId, 'Chat');
    const runId = requireId(input.runId, 'Execução');
    const requirements = normalizeRequirements(input.requirements ?? []);
    const candidate: ExecutionQualityGate = {
      id: this.createId(),
      chatId,
      runId,
      requireVerifiedCompletion: input.requireVerifiedCompletion ?? true,
      requirements,
      createdAt: this.now(),
    };
    const key = keyOf(chatId, runId);
    const existing = this.gates.get(key);
    if (existing) {
      if (sameGate(existing, candidate)) return cloneGate(existing);
      throw new Error(`O quality gate da execução ${runId} é imutável depois de configurado.`);
    }
    this.gates.set(key, candidate);
    return cloneGate(candidate);
  }

  restore(gates: ExecutionQualityGate[]): void {
    if (!Array.isArray(gates)) throw new Error('Quality gates persistidos inválidos.');
    this.gates.clear();
    for (const gate of gates) {
      try {
        const chatId = requireId(gate.chatId, 'Chat');
        const runId = requireId(gate.runId, 'Execução');
        const requirements = normalizeRequirements(gate.requirements ?? []);
        if (typeof gate.id !== 'string' || !gate.id.trim() || typeof gate.createdAt !== 'number' || !Number.isFinite(gate.createdAt) || gate.createdAt < 0) continue;
        this.gates.set(keyOf(chatId, runId), {
          id: gate.id.trim(),
          chatId,
          runId,
          requireVerifiedCompletion: Boolean(gate.requireVerifiedCompletion),
          requirements,
          createdAt: gate.createdAt,
        });
      } catch {
        // Invalid persisted entries are ignored instead of poisoning startup.
      }
    }
  }

  get(chatId: string, runId: string): ExecutionQualityGate | undefined {
    const gate = this.gates.get(keyOf(chatId, runId));
    return gate ? cloneGate(gate) : undefined;
  }

  list(chatId?: string): ExecutionQualityGate[] {
    return [...this.gates.values()]
      .filter((gate) => chatId === undefined || gate.chatId === chatId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(cloneGate);
  }

  removeChat(chatId: string): number {
    let removed = 0;
    for (const [key, gate] of this.gates) {
      if (gate.chatId !== chatId) continue;
      this.gates.delete(key);
      removed += 1;
    }
    return removed;
  }

  evaluate(report: ExecutionReport | undefined): ExecutionQualityGateEvaluation | undefined {
    if (!report) return undefined;
    const gate = this.get(report.chatId, report.runId);
    if (!gate) return { chatId: report.chatId, runId: report.runId, status: 'not_configured', checks: [] };

    const checks: ExecutionQualityGateCheck[] = [];
    if (gate.requireVerifiedCompletion) {
      checks.push({
        type: 'verified_completion',
        label: 'Conclusão verificada',
        required: 1,
        actual: report.completionProof === 'verified' ? 1 : 0,
        passed: report.completionProof === 'verified',
      });
    }
    for (const requirement of gate.requirements) {
      const actual = report.evidence[requirement.type] ?? 0;
      checks.push({
        type: requirement.type,
        label: requirement.label ?? `Evidência: ${requirement.type}`,
        required: requirement.minimum,
        actual,
        passed: actual >= requirement.minimum,
      });
    }

    const terminal = ['verified', 'unplanned', 'failed', 'interrupted', 'incomplete'].includes(report.completionProof);
    const allPassed = checks.every((check) => check.passed);
    if (!terminal) {
      return { chatId: report.chatId, runId: report.runId, gate, status: 'pending', checks };
    }
    if (allPassed) return { chatId: report.chatId, runId: report.runId, gate, status: 'passed', checks };
    return {
      chatId: report.chatId,
      runId: report.runId,
      gate,
      status: 'failed',
      checks,
      reason: report.completionProof === 'failed' ? report.error ?? 'A execução falhou.' : 'Um ou mais critérios objetivos de conclusão não foram atendidos.',
    };
  }
}
