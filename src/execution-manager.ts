export type ExecutionState = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted';

export type ExecutionSnapshot = {
  chatId: string;
  runId: string;
  state: ExecutionState;
  startedAt: number;
  updatedAt: number;
  currentTool?: string;
  error?: string;
};

export type ExecutionUpdate = {
  state: ExecutionState;
  currentTool?: string;
  error?: string;
};

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ExecutionManager {
  private readonly executions = new Map<string, ExecutionSnapshot>();

  start(chatId: string, now = Date.now(), runId = createRunId()): ExecutionSnapshot {
    const existing = this.executions.get(chatId);
    if (existing && (existing.state === 'running' || existing.state === 'waiting_approval')) {
      throw new Error(`O chat ${chatId} já possui uma execução ativa.`);
    }

    const snapshot: ExecutionSnapshot = {
      chatId,
      runId,
      state: 'running',
      startedAt: now,
      updatedAt: now,
    };
    this.executions.set(chatId, snapshot);
    return { ...snapshot };
  }

  update(chatId: string, update: ExecutionUpdate, now = Date.now()): ExecutionSnapshot {
    const current = this.executions.get(chatId);
    if (!current) {
      if (update.state !== 'running') throw new Error(`Nenhuma execução encontrada para o chat ${chatId}.`);
      return this.start(chatId, now);
    }

    const next: ExecutionSnapshot = {
      ...current,
      state: update.state,
      updatedAt: now,
      currentTool: update.currentTool,
      error: update.error,
    };
    this.executions.set(chatId, next);
    return { ...next };
  }

  get(chatId: string): ExecutionSnapshot | undefined {
    const snapshot = this.executions.get(chatId);
    return snapshot ? { ...snapshot } : undefined;
  }

  list(): ExecutionSnapshot[] {
    return [...this.executions.values()].map((snapshot) => ({ ...snapshot }));
  }

  listActive(): ExecutionSnapshot[] {
    return this.list().filter((snapshot) => snapshot.state === 'running' || snapshot.state === 'waiting_approval');
  }

  remove(chatId: string): void {
    this.executions.delete(chatId);
  }
}
