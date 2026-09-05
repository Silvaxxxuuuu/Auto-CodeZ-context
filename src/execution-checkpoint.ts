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

function validateCheckpoint(checkpoint: ExecutionCheckpoint): ExecutionCheckpoint {
  const normalized: ExecutionCheckpoint = {
    id: requireId(checkpoint.id, 'ID do checkpoint'),
    chatId: requireId(checkpoint.chatId, 'Chat'),
    runId: requireId(checkpoint.runId, 'Execução'),
    projectId: requireId(checkpoint.projectId, 'Projeto'),
    toolCallId: requireId(checkpoint.toolCallId, 'Tool call'),
    createdAt: checkpoint.createdAt,
    status: checkpoint.status,
    changes: validateChanges(checkpoint.changes),
    ...(checkpoint.restoredAt !== undefined ? { restoredAt: checkpoint.restoredAt } : {}),
  };
  if (!Number.isFinite(normalized.createdAt) || normalized.createdAt < 0) throw new Error('Data do checkpoint inválida.');
  if (normalized.status !== 'ready' && normalized.status !== 'restored') throw new Error('Status do checkpoint inválido.');
  if (normalized.status === 'ready' && normalized.restoredAt !== undefined) throw new Error('Checkpoint pronto não pode possuir data de restauração.');
  if (normalized.status === 'restored' && (!Number.isFinite(normalized.restoredAt) || normalized.restoredAt! < normalized.createdAt)) throw new Error('Data de restauração do checkpoint inválida.');
  return normalized;
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

async function undoChange(workspace: ExecutionCheckpointWorkspace, projectId: string, change: FileDiff): Promise<void> {
  if (change.type === 'created') {
    await workspace.deleteFile(projectId, change.path);
    return;
  }
  if (change.type === 'modified') {
    await workspace.writeFile(projectId, change.path, change.before);
    return;
  }
  if (change.type === 'deleted') {
    await workspace.createFile(projectId, change.path, change.before);
    return;
  }
  await workspace.renameFile(projectId, change.path, change.renamedFrom!);
  if (change.before !== change.after) await workspace.writeFile(projectId, change.renamedFrom!, change.before);
}

async function ensureAppliedState(workspace: ExecutionCheckpointWorkspace, projectId: string, change: FileDiff): Promise<void> {
  if (change.type === 'deleted') {
    if (await workspace.exists(projectId, change.path)) await workspace.deleteFile(projectId, change.path);
    return;
  }

  if (change.type === 'renamed') {
    const from = change.renamedFrom!;
    const sourceExists = await workspace.exists(projectId, from);
    const destinationExists = await workspace.exists(projectId, change.path);
    if (sourceExists && destinationExists) throw new Error(`Não foi possível recompor a renomeação de '${from}' para '${change.path}'.`);
    if (sourceExists) await workspace.renameFile(projectId, from, change.path);
    if (!(await workspace.exists(projectId, change.path))) throw new Error(`Destino ausente ao recompor '${change.path}'.`);
    if ((await workspace.readFile(projectId, change.path)) !== change.after) await workspace.writeFile(projectId, change.path, change.after);
    return;
  }

  if (await workspace.exists(projectId, change.path)) {
    if ((await workspace.readFile(projectId, change.path)) !== change.after) await workspace.writeFile(projectId, change.path, change.after);
  } else {
    await workspace.createFile(projectId, change.path, change.after);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExecutionCheckpointRuntime {
  private readonly checkpoints = new Map<string, ExecutionCheckpoint>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => `checkpoint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  ) {}

  hydrate(checkpoints: ExecutionCheckpoint[]): void {
    if (!Array.isArray(checkpoints)) throw new Error('Lista de checkpoints inválida.');
    const normalized = checkpoints.map(validateCheckpoint);
    const ids = new Set<string>();
    for (const checkpoint of normalized) {
      if (ids.has(checkpoint.id)) throw new Error(`Checkpoint duplicado: ${checkpoint.id}`);
      ids.add(checkpoint.id);
    }
    this.checkpoints.clear();
    for (const checkpoint of normalized) this.checkpoints.set(checkpoint.id, cloneCheckpoint(checkpoint));
  }

  record(input: {
    chatId: string;
    runId: string;
    projectId: string;
    toolCallId: string;
    changes: FileDiff[];
  }): ExecutionCheckpoint {
    const checkpoint = validateCheckpoint({
      id: this.createId(),
      chatId: input.chatId,
      runId: input.runId,
      projectId: input.projectId,
      toolCallId: input.toolCallId,
      createdAt: this.now(),
      status: 'ready',
      changes: input.changes,
    });
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

    const reverted: FileDiff[] = [];
    for (const change of [...checkpoint.changes].reverse()) {
      try {
        await undoChange(workspace, checkpoint.projectId, change);
        reverted.push(change);
      } catch (error) {
        const compensationErrors: string[] = [];
        for (const candidate of [change, ...[...reverted].reverse()]) {
          try {
            await ensureAppliedState(workspace, checkpoint.projectId, candidate);
          } catch (compensationError) {
            compensationErrors.push(`${candidate.path}: ${errorMessage(compensationError)}`);
          }
        }
        if (compensationErrors.length) {
          throw new Error(`A restauração falhou em '${change.path}' (${errorMessage(error)}) e a recomposição do workspace também falhou: ${compensationErrors.join('; ')}`);
        }
        throw new Error(`A restauração foi cancelada em '${change.path}' (${errorMessage(error)}). O workspace foi recomposto para o estado anterior ao rollback.`);
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
