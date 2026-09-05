import type { DiffPlan, FileDiff, ToolName } from './ai/types';

export type ExecutionChangeBudget = {
  maxFiles?: number;
  maxChangedLines?: number;
  maxCommands?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
};

export type ExecutionChangeUsage = {
  files: string[];
  changedLines: number;
  commands: number;
  toolCalls: number;
};

export type ExecutionChangeBudgetSnapshot = {
  chatId: string;
  runId: string;
  budget: ExecutionChangeBudget;
  usage: ExecutionChangeUsage;
  startedAt: number;
};

export type ExecutionChangeBudgetEvaluation = {
  chatId: string;
  runId: string;
  budget?: ExecutionChangeBudget;
  usage: ExecutionChangeUsage;
  projected: ExecutionChangeUsage;
  elapsedMs: number;
  allowed: boolean;
  violations: string[];
};

type RunBudgetState = {
  chatId: string;
  runId: string;
  budget: ExecutionChangeBudget;
  files: Set<string>;
  changedLines: number;
  commands: number;
  toolCalls: number;
  startedAt: number;
};

type ExecutionChangeBudgetListener = (snapshots: ExecutionChangeBudgetSnapshot[]) => void;

function keyOf(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function normalizeLimit(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} deve ser um inteiro não negativo.`);
  return value;
}

function normalizeBudget(budget: ExecutionChangeBudget): ExecutionChangeBudget {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new Error('Change Budget inválido.');
  return {
    maxFiles: normalizeLimit(budget.maxFiles, 'Limite de arquivos'),
    maxChangedLines: normalizeLimit(budget.maxChangedLines, 'Limite de linhas alteradas'),
    maxCommands: normalizeLimit(budget.maxCommands, 'Limite de comandos'),
    maxToolCalls: normalizeLimit(budget.maxToolCalls, 'Limite de ferramentas'),
    maxDurationMs: normalizeLimit(budget.maxDurationMs, 'Limite de duração'),
  };
}

function sameBudget(left: ExecutionChangeBudget, right: ExecutionChangeBudget): boolean {
  return left.maxFiles === right.maxFiles
    && left.maxChangedLines === right.maxChangedLines
    && left.maxCommands === right.maxCommands
    && left.maxToolCalls === right.maxToolCalls
    && left.maxDurationMs === right.maxDurationMs;
}

function cloneBudget(budget: ExecutionChangeBudget): ExecutionChangeBudget {
  return { ...budget };
}

function normalizeUsage(usage: ExecutionChangeUsage): ExecutionChangeUsage {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('Uso do Change Budget inválido.');
  if (!Array.isArray(usage.files) || usage.files.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('Arquivos do Change Budget inválidos.');
  const files = [...new Set(usage.files.map((item) => item.trim()))].sort();
  const values = [usage.changedLines, usage.commands, usage.toolCalls];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('Contadores do Change Budget inválidos.');
  return { files, changedLines: usage.changedLines, commands: usage.commands, toolCalls: usage.toolCalls };
}

function usageOf(state?: RunBudgetState): ExecutionChangeUsage {
  if (!state) return { files: [], changedLines: 0, commands: 0, toolCalls: 0 };
  return {
    files: [...state.files].sort(),
    changedLines: state.changedLines,
    commands: state.commands,
    toolCalls: state.toolCalls,
  };
}

function snapshotOf(state: RunBudgetState): ExecutionChangeBudgetSnapshot {
  return {
    chatId: state.chatId,
    runId: state.runId,
    budget: cloneBudget(state.budget),
    usage: usageOf(state),
    startedAt: state.startedAt,
  };
}

function stateFromSnapshot(snapshot: ExecutionChangeBudgetSnapshot): RunBudgetState {
  const chatId = requireId(snapshot.chatId, 'Chat');
  const runId = requireId(snapshot.runId, 'Execução');
  const budget = normalizeBudget(snapshot.budget);
  const usage = normalizeUsage(snapshot.usage);
  if (typeof snapshot.startedAt !== 'number' || !Number.isFinite(snapshot.startedAt) || snapshot.startedAt < 0) throw new Error('Data inicial do Change Budget inválida.');
  const staticViolations = violationsFor({ ...budget, maxDurationMs: undefined }, usage, 0);
  if (staticViolations.length) throw new Error(`Snapshot do Change Budget excede o próprio limite: ${staticViolations.join(' · ')}.`);
  return {
    chatId,
    runId,
    budget,
    files: new Set(usage.files),
    changedLines: usage.changedLines,
    commands: usage.commands,
    toolCalls: usage.toolCalls,
    startedAt: snapshot.startedAt,
  };
}

function changedLines(changes: FileDiff[] | undefined): number {
  if (!changes?.length) return 0;
  return changes.reduce((total, change) => total + Math.max(0, change.addedLines) + Math.max(0, change.removedLines), 0);
}

function changedPaths(changes: FileDiff[] | undefined): string[] {
  if (!changes?.length) return [];
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.renamedFrom) paths.add(change.renamedFrom);
    paths.add(change.path);
  }
  return [...paths];
}

function projectedUsage(
  state: RunBudgetState | undefined,
  input: { toolName: ToolName; diffPlan?: DiffPlan; changes?: FileDiff[] },
): ExecutionChangeUsage {
  const current = usageOf(state);
  const projectedFiles = new Set(current.files);
  const effectiveChanges = input.diffPlan?.changes ?? input.changes;
  for (const path of changedPaths(effectiveChanges)) projectedFiles.add(path);
  return {
    files: [...projectedFiles].sort(),
    changedLines: current.changedLines + changedLines(effectiveChanges),
    commands: current.commands + (input.toolName === 'run_command' ? 1 : 0),
    toolCalls: current.toolCalls + (input.toolName === 'plan_execution' || input.toolName === 'complete_plan_step' ? 0 : 1),
  };
}

function violationsFor(budget: ExecutionChangeBudget | undefined, usage: ExecutionChangeUsage, elapsedMs: number): string[] {
  if (!budget) return [];
  const violations: string[] = [];
  if (budget.maxFiles !== undefined && usage.files.length > budget.maxFiles) violations.push(`Arquivos: ${usage.files.length}/${budget.maxFiles}`);
  if (budget.maxChangedLines !== undefined && usage.changedLines > budget.maxChangedLines) violations.push(`Linhas alteradas: ${usage.changedLines}/${budget.maxChangedLines}`);
  if (budget.maxCommands !== undefined && usage.commands > budget.maxCommands) violations.push(`Comandos: ${usage.commands}/${budget.maxCommands}`);
  if (budget.maxToolCalls !== undefined && usage.toolCalls > budget.maxToolCalls) violations.push(`Ferramentas: ${usage.toolCalls}/${budget.maxToolCalls}`);
  if (budget.maxDurationMs !== undefined && elapsedMs > budget.maxDurationMs) violations.push(`Duração: ${elapsedMs}ms/${budget.maxDurationMs}ms`);
  return violations;
}

export class ExecutionChangeBudgetRuntime {
  private readonly runs = new Map<string, RunBudgetState>();
  private readonly listeners = new Set<ExecutionChangeBudgetListener>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: ExecutionChangeBudgetListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(chatId: string, runId: string, budget: ExecutionChangeBudget): ExecutionChangeBudget {
    const normalizedChatId = requireId(chatId, 'Chat');
    const normalizedRunId = requireId(runId, 'Execução');
    const normalizedBudget = normalizeBudget(budget);
    const key = keyOf(normalizedChatId, normalizedRunId);
    const existing = this.runs.get(key);
    if (existing) {
      if (sameBudget(existing.budget, normalizedBudget)) return cloneBudget(existing.budget);
      throw new Error(`O Change Budget da execução ${normalizedRunId} é imutável depois de configurado.`);
    }
    const startedAt = this.now();
    if (!Number.isFinite(startedAt) || startedAt < 0) throw new Error('Relógio inválido para o Change Budget.');
    this.runs.set(key, {
      chatId: normalizedChatId,
      runId: normalizedRunId,
      budget: normalizedBudget,
      files: new Set(),
      changedLines: 0,
      commands: 0,
      toolCalls: 0,
      startedAt,
    });
    this.emit();
    return cloneBudget(normalizedBudget);
  }

  restore(snapshots: ExecutionChangeBudgetSnapshot[]): void {
    if (!Array.isArray(snapshots)) throw new Error('Change Budgets persistidos inválidos.');
    const next = new Map<string, RunBudgetState>();
    for (const snapshot of snapshots) {
      const state = stateFromSnapshot(snapshot);
      const key = keyOf(state.chatId, state.runId);
      if (next.has(key)) throw new Error(`Change Budget duplicado para a execução ${state.runId}.`);
      next.set(key, state);
    }
    this.runs.clear();
    for (const [key, state] of next) this.runs.set(key, state);
  }

  list(chatId?: string): ExecutionChangeBudgetSnapshot[] {
    return [...this.runs.values()]
      .filter((state) => chatId === undefined || state.chatId === chatId)
      .sort((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId))
      .map(snapshotOf);
  }

  getBudget(chatId: string, runId: string): ExecutionChangeBudget | undefined {
    const state = this.runs.get(keyOf(chatId, runId));
    return state ? cloneBudget(state.budget) : undefined;
  }

  getUsage(chatId: string, runId: string): ExecutionChangeUsage {
    return usageOf(this.runs.get(keyOf(chatId, runId)));
  }

  evaluate(
    chatId: string,
    runId: string,
    input: { toolName: ToolName; diffPlan?: DiffPlan; changes?: FileDiff[] },
  ): ExecutionChangeBudgetEvaluation {
    const state = this.runs.get(keyOf(chatId, runId));
    const projected = projectedUsage(state, input);
    const now = this.now();
    const elapsedMs = state ? Math.max(0, now - state.startedAt) : 0;
    const violations = violationsFor(state?.budget, projected, elapsedMs);
    return {
      chatId,
      runId,
      budget: state ? cloneBudget(state.budget) : undefined,
      usage: usageOf(state),
      projected,
      elapsedMs,
      allowed: violations.length === 0,
      violations,
    };
  }

  assertAllowed(
    chatId: string,
    runId: string,
    input: { toolName: ToolName; diffPlan?: DiffPlan; changes?: FileDiff[] },
  ): ExecutionChangeBudgetEvaluation {
    const evaluation = this.evaluate(chatId, runId, input);
    if (!evaluation.allowed) throw new Error(`Change Budget excedido: ${evaluation.violations.join(' · ')}.`);
    return evaluation;
  }

  record(
    chatId: string,
    runId: string,
    input: { toolName: ToolName; changes?: FileDiff[] },
  ): ExecutionChangeUsage {
    const state = this.runs.get(keyOf(chatId, runId));
    if (!state) return usageOf(undefined);
    const projected = projectedUsage(state, input);
    const now = this.now();
    const elapsedMs = Math.max(0, now - state.startedAt);
    const violations = violationsFor(state.budget, projected, elapsedMs);
    if (violations.length) throw new Error(`Change Budget excedido: ${violations.join(' · ')}.`);
    state.files = new Set(projected.files);
    state.changedLines = projected.changedLines;
    state.commands = projected.commands;
    state.toolCalls = projected.toolCalls;
    this.emit();
    return usageOf(state);
  }

  removeChat(chatId: string): number {
    let removed = 0;
    for (const [key, state] of this.runs) {
      if (state.chatId !== chatId) continue;
      this.runs.delete(key);
      removed += 1;
    }
    if (removed) this.emit();
    return removed;
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const snapshots = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshots.map((snapshot) => ({ ...snapshot, budget: cloneBudget(snapshot.budget), usage: { ...snapshot.usage, files: [...snapshot.usage.files] } })));
      } catch {
      }
    }
  }
}
