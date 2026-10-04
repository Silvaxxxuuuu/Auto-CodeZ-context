import type { FileDiff } from './ai/types';
import type { ShadowWorkspaceSnapshot } from './agent/shadow-workspace';
import { ExecutionShadowWorkspaceRuntime } from './execution-shadow-workspace';
import { compactShadowWorkspaceChanges } from './shadow-workspace-publication';

export type ShadowCommitCheckpointRecord = {
  chatId: string;
  runId: string;
  projectId: string;
  toolCallId: string;
  changes: FileDiff[];
};

export type ShadowCommitResult = {
  committed: boolean;
  snapshot?: ShadowWorkspaceSnapshot;
  publicationChanges: FileDiff[];
  checkpointError?: string;
};

type CheckpointRecorder = (record: ShadowCommitCheckpointRecord) => void;

export class ExecutionShadowWorkspaceController {
  constructor(
    private readonly runtime: ExecutionShadowWorkspaceRuntime,
    private readonly recordCheckpoint?: CheckpointRecorder,
  ) {}

  async commitIfPresent(chatId: string, runId: string): Promise<ShadowCommitResult> {
    const active = this.runtime.get(chatId, runId);
    if (!active) return { committed: false, publicationChanges: [] };
    const publicationChanges = compactShadowWorkspaceChanges(active.changes);
    const committed = await this.runtime.commit(chatId, runId);
    let checkpointError: string | undefined;
    if (publicationChanges.length && this.recordCheckpoint) {
      try {
        this.recordCheckpoint({
          chatId,
          runId,
          projectId: active.projectId,
          toolCallId: `shadow-commit:${runId}`,
          changes: publicationChanges,
        });
      } catch (error) {
        checkpointError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      committed: true,
      snapshot: committed,
      publicationChanges: publicationChanges.map((change) => ({ ...change })),
      ...(checkpointError ? { checkpointError } : {}),
    };
  }

  discardIfPresent(chatId: string, runId: string): ShadowWorkspaceSnapshot | undefined {
    if (!this.runtime.get(chatId, runId)) return undefined;
    return this.runtime.discard(chatId, runId);
  }

  removeChat(chatId: string): number {
    return this.runtime.removeChat(chatId);
  }
}
