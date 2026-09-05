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
  runId?: string;
};

export type ExecutionChange =
  | { type: 'upsert'; snapshot: ExecutionSnapshot }
  | { type: 'remove'; chatId: string; runId?: string };

export type ExecutionListener = (change: ExecutionChange) => void;

const ACTIVE_STATES = new Set<ExecutionState>(['running', 'waiting_approval']);
const TERMINAL_STATES = new Set<ExecutionState>(['completed', 'failed', 'interrupted']);
const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionState, ReadonlySet<ExecutionState>>> = {
  idle: new Set<ExecutionState>(['running']),
  running: new Set<ExecutionState>(['running', 'waiting_approval', 'completed', 'failed', 'interrupted']),
  waiting_approval: new Set<ExecutionState>(['waiting_approval', 'running', 'failed', 'interrupted']),
  completed: new Set<ExecutionState>(['completed']),
  failed: new Set<ExecutionState>(['failed']),
  interrupted: new Set<ExecutionState>(['interrupted']),
};

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function requireTime(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} inválido.`);
  return value;
}

function isIdempotentTerminalUpdate(current: ExecutionSnapshot, update: ExecutionUpdate): boolean {
  return update.state === current.state
    && update.currentTool === current.currentTool
    && update.error === current.error;
}

export class ExecutionManager {
  private readonly executions = new Map<string, ExecutionSnapshot>();
  private readonly listeners = new Set<ExecutionListener>();

  subscribe(listener: ExecutionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(chatId: string, now = Date.now(), runId = createRunId()): ExecutionSnapshot {
    const normalizedChatId = requireId(chatId, 'Chat');
    const normalizedRunId = requireId(runId, 'Execução');
    const timestamp = requireTime(now, 'Data da execução');
    const existing = this.executions.get(normalizedChatId);
    if (existing && ACTIVE_STATES.has(existing.state)) {
      throw new Error(`O chat ${normalizedChatId} já possui uma execução ativa.`);
    }

    const snapshot: ExecutionSnapshot = {
      chatId: normalizedChatId,
      runId: normalizedRunId,
      state: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.executions.set(normalizedChatId, snapshot);
    this.emit({ type: 'upsert', snapshot: { ...snapshot } });
    return { ...snapshot };
  }

  update(chatId: string, update: ExecutionUpdate, now = Date.now()): ExecutionSnapshot {
    const normalizedChatId = requireId(chatId, 'Chat');
    const timestamp = requireTime(now, 'Data da atualização');
    const current = this.executions.get(normalizedChatId);
    if (!current) {
      if (update.state !== 'running') throw new Error(`Nenhuma execução encontrada para o chat ${normalizedChatId}.`);
      return this.start(normalizedChatId, timestamp, update.runId);
    }
    if (update.runId !== undefined && requireId(update.runId, 'Execução') !== current.runId) {
      throw new Error(`A execução ${update.runId} não corresponde à execução ativa do chat ${normalizedChatId}.`);
    }
    if (timestamp < current.updatedAt) {
      throw new Error(`Atualização obsoleta rejeitada para a execução ${current.runId}.`);
    }
    if (!ALLOWED_TRANSITIONS[current.state].has(update.state)) {
      throw new Error(`Transição inválida de ${current.state} para ${update.state} na execução ${current.runId}.`);
    }
    if (TERMINAL_STATES.has(current.state)) {
      if (isIdempotentTerminalUpdate(current, update)) return { ...current };
      throw new Error(`A execução ${current.runId} já está em estado terminal (${current.state}).`);
    }

    const active = ACTIVE_STATES.has(update.state);
    const next: ExecutionSnapshot = {
      ...current,
      state: update.state,
      updatedAt: timestamp,
      currentTool: active ? update.currentTool : undefined,
      error: update.state === 'failed' ? update.error : undefined,
    };
    this.executions.set(normalizedChatId, next);
    this.emit({ type: 'upsert', snapshot: { ...next } });
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
    return this.list().filter((snapshot) => ACTIVE_STATES.has(snapshot.state));
  }

  remove(chatId: string): void {
    const current = this.executions.get(chatId);
    if (!current) return;
    this.executions.delete(chatId);
    this.emit({ type: 'remove', chatId, runId: current.runId });
  }

  private emit(change: ExecutionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change.type === 'upsert' ? { type: 'upsert', snapshot: { ...change.snapshot } } : { ...change });
      } catch {
        // Execution observers must never interrupt the authoritative state transition.
      }
    }
  }
}
