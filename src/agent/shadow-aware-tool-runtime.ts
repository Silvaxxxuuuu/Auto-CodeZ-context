import type { AIToolCall, AIToolResult, PermissionLevel, ToolName } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { runWithExecutionWorkspaceContext } from './execution-workspace-context';
import { ToolRuntime } from './tool-runtime';

const gitMutationTools = new Set<ToolName>([
  'git_create_branch',
  'git_checkout',
  'git_stage',
  'git_stage_all',
  'git_commit',
]);

export class ShadowAwareToolRuntime extends ToolRuntime {
  private shadowWorkspaces?: ExecutionShadowWorkspaceRuntime;

  configureShadowWorkspace(runtime: ExecutionShadowWorkspaceRuntime): void {
    this.shadowWorkspaces = runtime;
  }

  override execute(
    chatId: string,
    projectId: string,
    permission: PermissionLevel,
    call: AIToolCall,
    runId?: string,
  ): Promise<AIToolResult> {
    if (!runId?.trim()) return super.execute(chatId, projectId, permission, call, runId);
    const blocked = this.blockedByActiveShadow(chatId, runId, call);
    if (blocked) return Promise.resolve(blocked);
    return runWithExecutionWorkspaceContext(
      { chatId, runId, projectId },
      () => super.execute(chatId, projectId, permission, call, runId),
    );
  }

  override approve(approvalId: string): Promise<AIToolResult> {
    const approval = this.listApprovals().find((item) => item.id === approvalId);
    if (!approval?.chatId || !approval.runId) return super.approve(approvalId);
    const blocked = this.blockedByActiveShadow(approval.chatId, approval.runId, approval.toolCall);
    if (blocked) return Promise.resolve(blocked);
    return runWithExecutionWorkspaceContext(
      { chatId: approval.chatId, runId: approval.runId, projectId: approval.projectId },
      () => super.approve(approvalId),
    );
  }

  private blockedByActiveShadow(chatId: string, runId: string, call: AIToolCall): AIToolResult | undefined {
    if (!gitMutationTools.has(call.name) || !this.shadowWorkspaces?.get(chatId, runId)) return undefined;
    return {
      toolCallId: call.id,
      ok: false,
      error: 'Operação Git mutável bloqueada enquanto existem alterações isoladas no Shadow Workspace. Leituras Git usam uma visão isolada; staging, checkout, branches novas e commits permanecem bloqueados até existir publicação Git transacional segura.',
    };
  }
}
