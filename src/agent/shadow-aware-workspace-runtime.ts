import type { ProjectRecord } from '../ai/types';
import { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { currentExecutionWorkspaceContext } from './execution-workspace-context';
import { WorkspaceRuntime } from './workspace-runtime';

export class ShadowAwareWorkspaceRuntime extends WorkspaceRuntime {
  constructor(
    private readonly baseWorkspace: WorkspaceRuntime,
    private readonly shadowWorkspaces: ExecutionShadowWorkspaceRuntime,
  ) {
    super(async () => []);
  }

  override getProject(projectId: string): Promise<ProjectRecord> {
    return this.baseWorkspace.getProject(projectId);
  }

  override resolve(projectId: string, requestedPath: string): Promise<string> {
    return this.baseWorkspace.resolve(projectId, requestedPath);
  }

  override async exists(projectId: string, requestedPath: string): Promise<boolean> {
    const shadow = this.existingShadow(projectId);
    return shadow
      ? shadow.exists(projectId, requestedPath)
      : this.baseWorkspace.exists(projectId, requestedPath);
  }

  override async readFile(projectId: string, requestedPath: string): Promise<string> {
    const shadow = this.existingShadow(projectId);
    return shadow
      ? shadow.readFile(projectId, requestedPath)
      : this.baseWorkspace.readFile(projectId, requestedPath);
  }

  override async writeFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    const shadow = this.mutationShadow(projectId);
    if (shadow) {
      await shadow.writeFile(projectId, requestedPath, content);
      return;
    }
    await this.baseWorkspace.writeFile(projectId, requestedPath, content);
  }

  override async createFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    const shadow = this.mutationShadow(projectId);
    if (shadow) {
      await shadow.createFile(projectId, requestedPath, content);
      return;
    }
    await this.baseWorkspace.createFile(projectId, requestedPath, content);
  }

  override async deleteFile(projectId: string, requestedPath: string): Promise<void> {
    const shadow = this.mutationShadow(projectId);
    if (shadow) {
      await shadow.deleteFile(projectId, requestedPath);
      return;
    }
    await this.baseWorkspace.deleteFile(projectId, requestedPath);
  }

  override async renameFile(projectId: string, from: string, to: string): Promise<void> {
    const shadow = this.mutationShadow(projectId);
    if (shadow) {
      await shadow.renameFile(projectId, from, to);
      return;
    }
    await this.baseWorkspace.renameFile(projectId, from, to);
  }

  override async searchFiles(projectId: string, query: string): Promise<string[]> {
    const shadow = this.existingShadow(projectId);
    return shadow
      ? shadow.searchFiles(projectId, query)
      : this.baseWorkspace.searchFiles(projectId, query);
  }

  private context(projectId: string) {
    const context = currentExecutionWorkspaceContext();
    if (!context) return undefined;
    if (context.projectId !== projectId) throw new Error('Contexto do Shadow Workspace pertence a outro projeto.');
    return context;
  }

  private existingShadow(projectId: string) {
    const context = this.context(projectId);
    if (!context) return undefined;
    if (!this.shadowWorkspaces.get(context.chatId, context.runId)) return undefined;
    return this.shadowWorkspaces.workspace(context.chatId, context.runId, projectId);
  }

  private mutationShadow(projectId: string) {
    const context = this.context(projectId);
    if (!context) return undefined;
    return this.shadowWorkspaces.workspace(context.chatId, context.runId, projectId);
  }
}
