import path from 'node:path';
import type { PermissionDecision } from './agent/permission-runtime';
import type { ToolName } from './ai/types';

export type ExecutionPathScopeSnapshot = {
  chatId: string;
  runId: string;
  projectId: string;
  allowedPaths: string[];
  configuredAt: number;
};

export type ExecutionPathScopeEvaluation = {
  configured: boolean;
  decision: PermissionDecision;
  reasons: string[];
  allowedPaths: string[];
  requestedPaths: string[];
};

type ExecutionPathScopeListener = (snapshots: ExecutionPathScopeSnapshot[]) => void;

const ambientReadTools = new Set<ToolName>(['git_diff']);
const ambientMutationTools = new Set<ToolName>(['git_checkout', 'git_stage_all', 'git_commit']);

function keyOf(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

export function normalizeExecutionScopePath(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Caminho permitido inválido.');
  const slash = value.trim().replaceAll('\\', '/');
  if (slash.includes('\u0000') || slash.startsWith('/') || /^[a-z]:\//i.test(slash) || slash.startsWith('//')) {
    throw new Error('Caminhos permitidos devem ser relativos ao workspace.');
  }
  const normalized = path.posix.normalize(slash.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Caminho permitido não pode sair do workspace.');
  return normalized === '' ? '.' : normalized.replace(/\/$/, '') || '.';
}

function normalizePaths(values: string[], allowEmpty: boolean): string[] {
  if (!Array.isArray(values)) throw new Error('Lista de caminhos permitidos inválida.');
  const normalized = [...new Set(values.map(normalizeExecutionScopePath))].sort();
  if (!allowEmpty && normalized.length === 0) throw new Error('O escopo precisa conter pelo menos um caminho permitido.');
  if (normalized.includes('.')) return ['.'];
  return normalized;
}

function cloneSnapshot(snapshot: ExecutionPathScopeSnapshot): ExecutionPathScopeSnapshot {
  return { ...snapshot, allowedPaths: [...snapshot.allowedPaths] };
}

function sameScope(left: ExecutionPathScopeSnapshot, right: Omit<ExecutionPathScopeSnapshot, 'configuredAt'>): boolean {
  return left.chatId === right.chatId
    && left.runId === right.runId
    && left.projectId === right.projectId
    && left.allowedPaths.length === right.allowedPaths.length
    && left.allowedPaths.every((value, index) => value === right.allowedPaths[index]);
}

function isWithinScope(candidate: string, allowedRoot: string): boolean {
  if (allowedRoot === '.') return true;
  return candidate === allowedRoot || candidate.startsWith(`${allowedRoot}/`);
}

export class ExecutionPathScopeRuntime {
  private readonly scopes = new Map<string, ExecutionPathScopeSnapshot>();
  private readonly listeners = new Set<ExecutionPathScopeListener>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: ExecutionPathScopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(input: Omit<ExecutionPathScopeSnapshot, 'configuredAt'>): ExecutionPathScopeSnapshot {
    const normalized: Omit<ExecutionPathScopeSnapshot, 'configuredAt'> = {
      chatId: requireId(input.chatId, 'Chat'),
      runId: requireId(input.runId, 'Execução'),
      projectId: requireId(input.projectId, 'Projeto'),
      allowedPaths: normalizePaths(input.allowedPaths, false),
    };
    const key = keyOf(normalized.chatId, normalized.runId);
    const existing = this.scopes.get(key);
    if (existing) {
      if (sameScope(existing, normalized)) return cloneSnapshot(existing);
      throw new Error(`O escopo de caminhos da execução ${normalized.runId} é imutável depois de configurado.`);
    }
    const configuredAt = this.now();
    if (!Number.isFinite(configuredAt) || configuredAt < 0) throw new Error('Relógio inválido para o escopo de caminhos.');
    const snapshot = { ...normalized, configuredAt };
    this.scopes.set(key, snapshot);
    this.emit();
    return cloneSnapshot(snapshot);
  }

  restore(snapshots: ExecutionPathScopeSnapshot[]): void {
    if (!Array.isArray(snapshots)) throw new Error('Escopos de caminhos persistidos inválidos.');
    const next = new Map<string, ExecutionPathScopeSnapshot>();
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== 'object') throw new Error('Snapshot de escopo de caminhos inválido.');
      const normalized: ExecutionPathScopeSnapshot = {
        chatId: requireId(snapshot.chatId, 'Chat'),
        runId: requireId(snapshot.runId, 'Execução'),
        projectId: requireId(snapshot.projectId, 'Projeto'),
        allowedPaths: normalizePaths(snapshot.allowedPaths, false),
        configuredAt: snapshot.configuredAt,
      };
      if (!Number.isFinite(normalized.configuredAt) || normalized.configuredAt < 0) throw new Error('Data do escopo de caminhos inválida.');
      const key = keyOf(normalized.chatId, normalized.runId);
      if (next.has(key)) throw new Error(`Escopo de caminhos duplicado para a execução ${normalized.runId}.`);
      next.set(key, normalized);
    }
    this.scopes.clear();
    for (const [key, value] of next) this.scopes.set(key, value);
  }

  get(chatId: string, runId: string): ExecutionPathScopeSnapshot | undefined {
    const scope = this.scopes.get(keyOf(chatId, runId));
    return scope ? cloneSnapshot(scope) : undefined;
  }

  list(chatId?: string): ExecutionPathScopeSnapshot[] {
    return [...this.scopes.values()]
      .filter((scope) => chatId === undefined || scope.chatId === chatId)
      .sort((left, right) => right.configuredAt - left.configuredAt || left.runId.localeCompare(right.runId))
      .map(cloneSnapshot);
  }

  allowsPath(chatId: string, runId: string, projectId: string, candidatePath: string): boolean {
    const scope = this.scopes.get(keyOf(chatId, runId));
    if (!scope) return true;
    if (scope.projectId !== projectId) return false;
    const candidate = normalizeExecutionScopePath(candidatePath);
    return scope.allowedPaths.some((allowed) => isWithinScope(candidate, allowed));
  }

  evaluate(input: {
    chatId?: string;
    runId?: string;
    projectId: string;
    toolName: ToolName;
    paths?: string[];
  }): ExecutionPathScopeEvaluation {
    if (!input.chatId || !input.runId) {
      return { configured: false, decision: 'allow', reasons: [], allowedPaths: [], requestedPaths: [] };
    }
    const scope = this.scopes.get(keyOf(input.chatId, input.runId));
    if (!scope) return { configured: false, decision: 'allow', reasons: [], allowedPaths: [], requestedPaths: [] };

    const requestedPaths = normalizePaths(input.paths ?? [], true);
    if (scope.projectId !== input.projectId) {
      return {
        configured: true,
        decision: 'deny',
        reasons: ['a execução está vinculada a outro projeto'],
        allowedPaths: [...scope.allowedPaths],
        requestedPaths,
      };
    }

    if (input.toolName === 'run_command') {
      return {
        configured: true,
        decision: 'ask',
        reasons: ['o shell não é totalmente confinável pela allowlist de caminhos'],
        allowedPaths: [...scope.allowedPaths],
        requestedPaths,
      };
    }

    if (ambientReadTools.has(input.toolName)) {
      return {
        configured: true,
        decision: 'ask',
        reasons: [`${input.toolName} pode observar caminhos fora do escopo configurado`],
        allowedPaths: [...scope.allowedPaths],
        requestedPaths,
      };
    }

    if (ambientMutationTools.has(input.toolName)) {
      return {
        configured: true,
        decision: 'deny',
        reasons: [`${input.toolName} pode alterar estado fora do escopo configurado`],
        allowedPaths: [...scope.allowedPaths],
        requestedPaths,
      };
    }

    const outside = requestedPaths.filter((candidate) => !scope.allowedPaths.some((allowed) => isWithinScope(candidate, allowed)));
    if (outside.length) {
      return {
        configured: true,
        decision: 'deny',
        reasons: [`caminho fora do escopo permitido: ${outside.join(', ')}`],
        allowedPaths: [...scope.allowedPaths],
        requestedPaths,
      };
    }

    return {
      configured: true,
      decision: 'allow',
      reasons: [],
      allowedPaths: [...scope.allowedPaths],
      requestedPaths,
    };
  }

  removeChat(chatId: string): number {
    let removed = 0;
    for (const [key, scope] of this.scopes) {
      if (scope.chatId !== chatId) continue;
      this.scopes.delete(key);
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
        listener(snapshots.map(cloneSnapshot));
      } catch {
      }
    }
  }
}
