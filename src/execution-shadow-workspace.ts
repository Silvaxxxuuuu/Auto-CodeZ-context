import type { ShadowWorkspaceBase, ShadowWorkspaceSnapshot } from './agent/shadow-workspace';
import { ShadowWorkspaceTransaction } from './agent/shadow-workspace';

export type ExecutionShadowWorkspaceListener = (snapshots: ShadowWorkspaceSnapshot[]) => void;

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function keyOf(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function cloneSnapshot(snapshot: ShadowWorkspaceSnapshot): ShadowWorkspaceSnapshot {
  return {
    ...snapshot,
    changes: snapshot.changes.map((change) => ({ ...change })),
  };
}

export class ExecutionShadowWorkspaceRuntime {
  private readonly transactions = new Map<string, ShadowWorkspaceTransaction>();
  private readonly listeners = new Set<ExecutionShadowWorkspaceListener>();

  constructor(
    private readonly base: ShadowWorkspaceBase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  subscribe(listener: ExecutionShadowWorkspaceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  begin(chatId: string, runId: string, projectId: string): ShadowWorkspaceTransaction {
    const normalizedChatId = requireId(chatId, 'Chat');
    const normalizedRunId = requireId(runId, 'Execução');
    const normalizedProjectId = requireId(projectId, 'Projeto');
    const key = keyOf(normalizedChatId, normalizedRunId);
    const current = this.transactions.get(key);
    if (current) {
      if (current.projectId !== normalizedProjectId) throw new Error('A execução já possui Shadow Workspace de outro projeto.');
      return current;
    }
    const transaction = new ShadowWorkspaceTransaction(
      this.base,
      { chatId: normalizedChatId, runId: normalizedRunId, projectId: normalizedProjectId },
      undefined,
      this.now,
    );
    this.transactions.set(key, transaction);
    this.emit();
    return transaction;
  }

  workspace(chatId: string, runId: string, projectId: string): ShadowWorkspaceBase {
    const transaction = this.begin(chatId, runId, projectId);
    const notifyAfter = async <T>(operation: () => Promise<T>): Promise<T> => {
      const result = await operation();
      this.emit();
      return result;
    };
    return {
      exists: (requestedProjectId, requestedPath) => transaction.exists(requestedProjectId, requestedPath),
      readFile: (requestedProjectId, requestedPath) => transaction.readFile(requestedProjectId, requestedPath),
      writeFile: (requestedProjectId, requestedPath, content) => notifyAfter(() => transaction.writeFile(requestedProjectId, requestedPath, content)),
      createFile: (requestedProjectId, requestedPath, content) => notifyAfter(() => transaction.createFile(requestedProjectId, requestedPath, content)),
      deleteFile: (requestedProjectId, requestedPath) => notifyAfter(() => transaction.deleteFile(requestedProjectId, requestedPath)),
      renameFile: (requestedProjectId, from, to) => notifyAfter(() => transaction.renameFile(requestedProjectId, from, to)),
      searchFiles: (requestedProjectId, query) => transaction.searchFiles(requestedProjectId, query),
    };
  }

  get(chatId: string, runId: string): ShadowWorkspaceSnapshot | undefined {
    const transaction = this.transactions.get(keyOf(requireId(chatId, 'Chat'), requireId(runId, 'Execução')));
    return transaction ? cloneSnapshot(transaction.snapshot()) : undefined;
  }

  list(chatId?: string): ShadowWorkspaceSnapshot[] {
    return [...this.transactions.values()]
      .filter((transaction) => chatId === undefined || transaction.chatId === chatId)
      .map((transaction) => transaction.snapshot())
      .filter((snapshot) => snapshot.status === 'active')
      .sort((left, right) => right.updatedAt - left.updatedAt || left.runId.localeCompare(right.runId))
      .map(cloneSnapshot);
  }

  restore(snapshots: ShadowWorkspaceSnapshot[]): void {
    if (!Array.isArray(snapshots)) throw new Error('Shadow Workspaces persistidos inválidos.');
    const next = new Map<string, ShadowWorkspaceTransaction>();
    for (const snapshot of snapshots) {
      const transaction = ShadowWorkspaceTransaction.restore(this.base, snapshot, undefined, this.now);
      const key = keyOf(transaction.chatId, transaction.runId);
      if (next.has(key)) throw new Error(`Shadow Workspace duplicado para a execução ${transaction.runId}.`);
      next.set(key, transaction);
    }
    this.transactions.clear();
    for (const [key, transaction] of next) this.transactions.set(key, transaction);
  }

  async commit(chatId: string, runId: string): Promise<ShadowWorkspaceSnapshot> {
    const normalizedChatId = requireId(chatId, 'Chat');
    const normalizedRunId = requireId(runId, 'Execução');
    const key = keyOf(normalizedChatId, normalizedRunId);
    const transaction = this.transactions.get(key);
    if (!transaction) throw new Error('Shadow Workspace da execução não encontrado.');
    const snapshot = await transaction.commit();
    this.transactions.delete(key);
    this.emit();
    return cloneSnapshot(snapshot);
  }

  discard(chatId: string, runId: string): ShadowWorkspaceSnapshot {
    const normalizedChatId = requireId(chatId, 'Chat');
    const normalizedRunId = requireId(runId, 'Execução');
    const key = keyOf(normalizedChatId, normalizedRunId);
    const transaction = this.transactions.get(key);
    if (!transaction) throw new Error('Shadow Workspace da execução não encontrado.');
    const snapshot = transaction.discard();
    this.transactions.delete(key);
    this.emit();
    return cloneSnapshot(snapshot);
  }

  removeChat(chatId: string): number {
    const normalizedChatId = requireId(chatId, 'Chat');
    let removed = 0;
    for (const [key, transaction] of this.transactions) {
      if (transaction.chatId !== normalizedChatId) continue;
      this.transactions.delete(key);
      removed += 1;
    }
    if (removed) this.emit();
    return removed;
  }

  private emit(): void {
    const snapshots = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshots.map(cloneSnapshot));
      } catch {
      }
    }
  }
}
