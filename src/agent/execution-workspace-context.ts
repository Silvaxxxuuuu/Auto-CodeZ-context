import { AsyncLocalStorage } from 'node:async_hooks';

export type ExecutionWorkspaceContext = {
  chatId: string;
  runId: string;
  projectId: string;
};

const storage = new AsyncLocalStorage<ExecutionWorkspaceContext>();

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

export function runWithExecutionWorkspaceContext<T>(
  context: ExecutionWorkspaceContext,
  operation: () => Promise<T>,
): Promise<T> {
  const normalized: ExecutionWorkspaceContext = {
    chatId: requireId(context.chatId, 'Chat'),
    runId: requireId(context.runId, 'Execução'),
    projectId: requireId(context.projectId, 'Projeto'),
  };
  return storage.run(normalized, operation);
}

export function currentExecutionWorkspaceContext(): ExecutionWorkspaceContext | undefined {
  const context = storage.getStore();
  return context ? { ...context } : undefined;
}
