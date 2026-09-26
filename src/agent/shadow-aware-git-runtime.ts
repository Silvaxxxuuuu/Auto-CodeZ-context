import type { GitOperationSummary, ProjectRecord } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { currentExecutionWorkspaceContext } from './execution-workspace-context';
import {
  GitRuntime,
  type GitBranch,
  type GitCommitSummary,
  type GitStatus,
} from './git-runtime';
import { ShadowGitReadRuntime } from './shadow-git-read-runtime';

type ActiveExecutionShadow = {
  chatId: string;
  runId: string;
};

export class ShadowAwareGitRuntime extends GitRuntime {
  private readonly shadowReads: ShadowGitReadRuntime;

  constructor(
    projectProvider: () => Promise<ProjectRecord[]>,
    private readonly shadows: ExecutionShadowWorkspaceRuntime,
    shadowReads?: ShadowGitReadRuntime,
  ) {
    super(projectProvider);
    this.shadowReads = shadowReads ?? new ShadowGitReadRuntime(projectProvider, shadows);
  }

  override async status(projectId: string): Promise<GitStatus> {
    const shadow = this.executionShadow(projectId);
    return shadow
      ? this.shadowReads.status(shadow.chatId, shadow.runId, projectId)
      : super.status(projectId);
  }

  override async diff(projectId: string): Promise<string> {
    const shadow = this.executionShadow(projectId);
    return shadow
      ? this.shadowReads.diff(shadow.chatId, shadow.runId, projectId)
      : super.diff(projectId);
  }

  override branches(projectId: string): Promise<GitBranch[]> {
    this.assertContextProject(projectId);
    return super.branches(projectId);
  }

  override log(projectId: string, limit = 20): Promise<GitCommitSummary[]> {
    this.assertContextProject(projectId);
    return super.log(projectId, limit);
  }

  override createBranch(projectId: string, name: string): Promise<GitOperationSummary> {
    this.assertMutationAllowed(projectId);
    return super.createBranch(projectId, name);
  }

  override checkout(projectId: string, name: string): Promise<GitOperationSummary> {
    this.assertMutationAllowed(projectId);
    return super.checkout(projectId, name);
  }

  override stage(projectId: string, paths: string[]): Promise<GitOperationSummary> {
    this.assertMutationAllowed(projectId);
    return super.stage(projectId, paths);
  }

  override stageAll(projectId: string): Promise<GitOperationSummary> {
    this.assertMutationAllowed(projectId);
    return super.stageAll(projectId);
  }

  override commit(projectId: string, message: string): Promise<GitOperationSummary> {
    this.assertMutationAllowed(projectId);
    return super.commit(projectId, message);
  }

  private assertContextProject(projectId: string): void {
    const context = currentExecutionWorkspaceContext();
    if (context && context.projectId !== projectId) {
      throw new Error('Contexto Git da execução pertence a outro projeto.');
    }
  }

  private executionShadow(projectId: string): ActiveExecutionShadow | undefined {
    this.assertContextProject(projectId);
    const context = currentExecutionWorkspaceContext();
    if (!context) return undefined;
    if (!this.shadows.get(context.chatId, context.runId)) return undefined;
    return { chatId: context.chatId, runId: context.runId };
  }

  private assertMutationAllowed(projectId: string): void {
    this.assertContextProject(projectId);
    if (this.shadows.list().some((snapshot) => snapshot.projectId === projectId)) {
      throw new Error('Operação Git mutável bloqueada enquanto existe Shadow Workspace ativo neste projeto.');
    }
  }
}
