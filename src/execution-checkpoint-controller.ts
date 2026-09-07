import type { FileDiff } from './ai/types';
import type { ExecutionManager } from './execution-manager';
import type { ExecutionCheckpoint, ExecutionCheckpointWorkspace } from './execution-checkpoint';
import { ExecutionCheckpointRuntime } from './execution-checkpoint';

export type ExecutionCheckpointChangeSummary = Pick<FileDiff, 'path' | 'type' | 'addedLines' | 'removedLines' | 'renamedFrom'>;

export type ExecutionCheckpointSummary = Omit<ExecutionCheckpoint, 'changes'> & {
  changes: ExecutionCheckpointChangeSummary[];
};

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function summarize(checkpoint: ExecutionCheckpoint): ExecutionCheckpointSummary {
  return {
    id: checkpoint.id,
    chatId: checkpoint.chatId,
    runId: checkpoint.runId,
    projectId: checkpoint.projectId,
    toolCallId: checkpoint.toolCallId,
    createdAt: checkpoint.createdAt,
    status: checkpoint.status,
    ...(checkpoint.restoredAt !== undefined ? { restoredAt: checkpoint.restoredAt } : {}),
    changes: checkpoint.changes.map((change) => ({
      path: change.path,
      type: change.type,
      addedLines: change.addedLines,
      removedLines: change.removedLines,
      ...(change.renamedFrom !== undefined ? { renamedFrom: change.renamedFrom } : {}),
    })),
  };
}

export class ExecutionCheckpointController {
  constructor(
    private readonly runtime: ExecutionCheckpointRuntime,
    private readonly workspace: ExecutionCheckpointWorkspace,
    private readonly executions: ExecutionManager,
    private readonly onChanged?: (checkpoints: ExecutionCheckpoint[]) => void,
  ) {}

  list(chatId?: string, runId?: string): ExecutionCheckpointSummary[] {
    const normalizedChatId = chatId === undefined ? undefined : requireId(chatId, 'Chat');
    const normalizedRunId = runId === undefined ? undefined : requireId(runId, 'Execução');
    return this.runtime.list(normalizedChatId, normalizedRunId).map(summarize);
  }

  async restore(input: { checkpointId: string; chatId: string; runId: string }): Promise<ExecutionCheckpointSummary> {
    const checkpointId = requireId(input.checkpointId, 'Checkpoint');
    const chatId = requireId(input.chatId, 'Chat');
    const runId = requireId(input.runId, 'Execução');
    const checkpoint = this.runtime.get(checkpointId);
    if (!checkpoint) throw new Error('Checkpoint não encontrado.');
    if (checkpoint.chatId !== chatId || checkpoint.runId !== runId) {
      throw new Error('O checkpoint não pertence à execução informada.');
    }

    const current = this.executions.get(chatId);
    if (current && (current.state === 'running' || current.state === 'waiting_approval')) {
      throw new Error('Não é possível restaurar um checkpoint enquanto o chat possui uma execução ativa.');
    }

    const restored = await this.runtime.restore(checkpointId, this.workspace);
    this.onChanged?.(this.runtime.list());
    return summarize(restored);
  }
}
