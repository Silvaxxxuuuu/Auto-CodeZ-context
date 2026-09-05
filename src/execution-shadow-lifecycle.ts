import type { ExecutionCompletion, ExecutionCoordinator } from './execution-coordinator';
import type { ExecutionSnapshot } from './execution-manager';
import type { ExecutionShadowWorkspaceController, ShadowCommitResult } from './execution-shadow-workspace-controller';

export type ShadowCompletionResult = {
  completion: ExecutionCompletion;
  publication?: ShadowCommitResult;
};

export class ExecutionShadowLifecycle {
  constructor(
    private readonly coordinator: ExecutionCoordinator,
    private readonly shadows: ExecutionShadowWorkspaceController,
    private readonly isRecoverable: (chatId: string, runId: string) => boolean,
  ) {}

  async complete(chatId: string, runId: string): Promise<ShadowCompletionResult> {
    const preflight = this.coordinator.completionPreflight(chatId, runId);
    if (!preflight.allowed) {
      this.shadows.discardIfPresent(chatId, runId);
      return { completion: this.coordinator.complete(chatId, runId) };
    }

    try {
      const publication = await this.shadows.commitIfPresent(chatId, runId);
      return {
        completion: this.coordinator.complete(chatId, runId),
        ...(publication.committed ? { publication } : {}),
      };
    } catch (error) {
      this.shadows.discardIfPresent(chatId, runId);
      const message = error instanceof Error ? error.message : String(error);
      this.coordinator.fail(chatId, runId, message);
      throw error;
    }
  }

  fail(chatId: string, runId: string, error: string): ExecutionCompletion {
    const completion = this.coordinator.fail(chatId, runId, error);
    if (!this.isRecoverable(chatId, runId)) this.shadows.discardIfPresent(chatId, runId);
    return completion;
  }

  interrupt(chatId: string, runId: string): ExecutionSnapshot | undefined {
    this.shadows.discardIfPresent(chatId, runId);
    return this.coordinator.interrupt(chatId, runId);
  }

  clearChat(chatId: string): void {
    this.shadows.removeChat(chatId);
  }
}
