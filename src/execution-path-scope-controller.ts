import { SYSTEM_PROJECT_ID } from './agent/command-runtime';
import type { ExecutionPathScopeRuntime, ExecutionPathScopeSnapshot } from './execution-path-scope';
import type { ExecutionTaskCapsuleRuntime } from './execution-task-capsule';

export interface ExecutionPathScopeToolConfigurator {
  configureExecutionAllowedPaths(chatId: string, runId: string, projectId: string, allowedPaths: string[]): Promise<ExecutionPathScopeSnapshot>;
}

export type ConfigureExecutionPathScopeInput = {
  chatId: string;
  runId: string;
  allowedPaths: string[];
};

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function requireAllowedPaths(value: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('O escopo precisa conter pelo menos um caminho permitido.');
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('Caminho permitido inválido.');
    return item.trim();
  });
}

export class ExecutionPathScopeController {
  constructor(
    private readonly capsules: ExecutionTaskCapsuleRuntime,
    private readonly scopes: ExecutionPathScopeRuntime,
    private readonly tools: ExecutionPathScopeToolConfigurator,
    private readonly systemProjectId = SYSTEM_PROJECT_ID,
  ) {}

  async configure(input: ConfigureExecutionPathScopeInput): Promise<ExecutionPathScopeSnapshot> {
    const chatId = requireId(input.chatId, 'Chat');
    const runId = requireId(input.runId, 'Execução');
    const capsule = this.capsules.get(chatId, runId);
    if (!capsule) throw new Error('Task Capsule da execução não encontrada.');
    const projectId = capsule.projectId ?? this.systemProjectId;
    return this.tools.configureExecutionAllowedPaths(chatId, runId, projectId, requireAllowedPaths(input.allowedPaths));
  }

  get(chatId: string, runId: string): ExecutionPathScopeSnapshot | undefined {
    return this.scopes.get(requireId(chatId, 'Chat'), requireId(runId, 'Execução'));
  }

  list(filters?: { chatId?: string; runId?: string }): ExecutionPathScopeSnapshot[] {
    const chatId = filters?.chatId === undefined ? undefined : requireId(filters.chatId, 'Chat');
    const runId = filters?.runId === undefined ? undefined : requireId(filters.runId, 'Execução');
    return this.scopes.list(chatId).filter((scope) => runId === undefined || scope.runId === runId);
  }

  removeChat(chatId: string): number {
    return this.scopes.removeChat(requireId(chatId, 'Chat'));
  }
}
