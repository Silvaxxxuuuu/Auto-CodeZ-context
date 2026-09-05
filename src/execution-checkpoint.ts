import type { FileDiff } from './ai/types';

export type ExecutionCheckpointStatus = 'ready' | 'restored';

export type ExecutionCheckpoint = {
  id: string;
  chatId: string;
  runId: string;
  projectId: string;
  toolCallId: string;
  createdAt: number;
  restoredAt?: number;
  status: ExecutionCheckpointStatus;
  changes: FileDiff[];
};

export interface ExecutionCheckpointWorkspace {
  exists(projectId: string, path: string): Promise<boolean>;
  readFile(projectId: string, path: string): Promise<string>;
  writeFile(projectId: string, path: string, content: string): Promise<void>;
  createFile(projectId: string, path: string, content: string): Promise<void>;
  deleteFile(projectId: string, path: string): Promise<void>;
  renameFile(projectId: string, from: string, to: string): Promise<void>;
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function normalizePathKey(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase();
}

function cloneChanges(changes: FileDiff[]): FileDiff[] {
  return changes.map((change) => ({ ...change }));
}

function cloneCheckpoint(checkpoint: ExecutionCheckpoint): ExecutionCheckpoint {
  return { ...checkpoint, changes: cloneChanges(checkpoint.changes) };
}

function validateChanges(changes: FileDiff[]): FileDiff[] {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('O checkpoint precisa conter ao menos uma alteração.');
  const paths = new Set<string>();
  for (const change of changes) {
    if (!change || typeof change !== 'object') throw new Error('Alteração inválida no checkpoint.');
    if (!['created', 'modified', 'deleted', 'renamed'].includes(change.type)) throw new Error('Tipo de alteração inválido no checkpoint.');
    if (typeof change.path !== 'string' || !change.path.trim()) throw new Error('Caminho inválido no checkpoint.');
    if (typeof change.before !== 'string' || typeof change.after !== 'string') throw new Error('Conteúdo inválido no checkpoint.');
    if (!Number.isInteger(change.addedLines) || change.addedLines < 0 || !Number.isInteger(change.removedLines) || change.removedLines < 0) throw new Error('Contagem de linhas inválida no checkpoint.');
    if (change.type === 'renamed') {
      if (typeof change.renamedFrom !== 'string' || !change.renamedFrom.trim()) throw new Error('Renomeação sem caminho de origem no checkpoint.');
    } else if (change.renamedFrom !== undefined) {
      throw new Error('Somente renomeações podem informar caminho de origem no checkpoint.');
    }

    const touched = change.type === 'renamed' ? [change.renamedFrom!, change.path] : [change.path];
    for (const item of touched) {
      const key = normalizePathKey(item);
      if (paths.has(key)) throw new Error(`O checkpoint contém caminhos sobrepostos: ${item}`);
      paths.add(key);
    }
  }
  return cloneChanges(changes);
}

async function matchesExpectedState(workspace: ExecutionCheckpointWorkspace, projectId: string, change: FileDiff): Promise<boolean> {
  try {
    if (change.type === 'deleted') return !(await workspace.exists(projectId, change.path));
    if (change.type === 'renamed') {
      if (await workspace.exists(projectId, change.renamedFrom!)) return false;
      if (!(await workspace.exists(projectId, change.path))) return false;
      return (await workspace.readFile(projectId, change.path)) === change.after;
    }
    if (!(await workspace.exists(projectId, change.path))) return false;
    return (await workspace.readFile(projectId, change.path)) === change.after;
  } catch {
    return false;
  }
}

export class ExecutionCheckpointRuntime {
  private readonly checkpoints = new Map<string, ExecutionCheckpoint>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => `checkpoint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  ) {}

  record(input: {
    chatId: string;
    runId: string;
    projectId: string;
    toolCallId: string;
    changes: FileDiff[];
  }): ExecutionCheckpoint {
    const checkpoint: ExecutionCheckpoint = {
      id: requireId(this.createId(), 'ID do checkpoint'),
      chatId: requireId(input.chatId, 'Chat'),
      runId: requireId(input.runId, 'Execução'),
      projectId: requireId(input.projectId, 'Projeto'),
      toolCallId: requireId(input.toolCallId, 'Tool call'),
      createdAt: this.now(),
      status: 'ready',
      changes: validateChanges(input.changes),
    };
    if (!Number.isFinite(checkpoint.createdAt) || checkpoint.createdAt < 0) throw new Error('Data do checkpoint inválida.');
    if (this.checkpoints.has(checkpoint.id)) throw new Error(`Checkpoint duplicado: ${checkpoint.id}`);
    this.checkpoints.set(checkpoint.id, checkpoint);
    return cloneCheckpoint(checkpoint);
  }

  get(id: string): ExecutionCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(id);
    return checkpoint ? cloneCheckpoint(checkpoint) : undefined;
  }

  list(chatId?: string, runId?: string): ExecutionCheckpoint[] {
    return [...this.checkpoints.values()]
      .filter((checkpoint) => (chatId === undefined || checkpoint.chatId === chatId) && (runId === undefined || checkpoint.runId === runId))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(cloneCheckpoint);
  }

  async restore(id: string, workspace: ExecutionCheckpointWorkspace): Promise<ExecutionCheckpoint> {
    const checkpoint = this.checkpoints.get(requireId(id, 'Checkpoint'));
    if (!checkpoint) throw new Error('Checkpoint não encontrado.');
    if (checkpoint.status === 'restored') throw new Error('Este checkpoint já foi restaurado.');

    for (const change of checkpoint.changes) {
      if (!(await matchesExpectedState(workspace, checkpoint.projectId, change))) {
        throw new Error('Restauração bloqueada: o workspace mudou após este checkpoint.');
      }
    }

    for (const change of [...checkpoint.changes].reverse()) {
      if (change.type === 'created') {
        await workspace.deleteFile(checkpoint.projectId, change.path);
      } else if (change.type === 'modified') {
        await workspace.writeFile(checkpoint.projectId, change.path, change.before);
      } else if (change.type === 'deleted') {
        await workspace.createFile(checkpoint.projectId, change.path, change.before);
      } else {
        await workspace.renameFile(checkpoint.projectId, change.path, change.renamedFrom!);
        if (change.before !== change.after) await workspace.writeFile(checkpoint.projectId, change.renamedFrom!, change.before);
      }
    }

    checkpoint.status = 'restored';
    checkpoint.restoredAt = this.now();
    return cloneCheckpoint(checkpoint);
  }

  removeChat(chatId: string): number {
    let removed = 0;
    for (const [id, checkpoint] of this.checkpoints) {
      if (checkpoint.chatId !== chatId) continue;
      this.checkpoints.delete(id);
      removed += 1;
    }
    return removed;
  }
}
