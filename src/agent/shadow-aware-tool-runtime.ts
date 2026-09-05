import type { AIToolCall, AIToolResult, PermissionLevel } from '../ai/types';
import { runWithExecutionWorkspaceContext } from './execution-workspace-context';
import { ToolRuntime } from './tool-runtime';

export class ShadowAwareToolRuntime extends ToolRuntime {
  override execute(
    chatId: string,
    projectId: string,
    permission: PermissionLevel,
    call: AIToolCall,
    runId?: string,
  ): Promise<AIToolResult> {
    if (!runId?.trim()) return super.execute(chatId, projectId, permission, call, runId);
    return runWithExecutionWorkspaceContext(
      { chatId, runId, projectId },
      () => super.execute(chatId, projectId, permission, call, runId),
    );
  }

  override approve(approvalId: string): Promise<AIToolResult> {
    const approval = this.listApprovals().find((item) => item.id === approvalId);
    if (!approval?.chatId || !approval.runId) return super.approve(approvalId);
    return runWithExecutionWorkspaceContext(
      { chatId: approval.chatId, runId: approval.runId, projectId: approval.projectId },
      () => super.approve(approvalId),
    );
  }
}
