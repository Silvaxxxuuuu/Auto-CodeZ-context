import type { ActivityEvent, AIToolResult, ToolName } from '../ai/types';

export interface ToolActivitySnapshot {
  type: ActivityEvent['type'];
  message: string;
  status: ActivityEvent['status'];
  runId: string;
  toolCallId: string;
  toolName: ToolName;
  result: AIToolResult;
}

function activityType(toolName: ToolName): ActivityEvent['type'] {
  if (toolName === 'run_command') return 'test';
  if (toolName === 'git_status' || toolName === 'git_diff' || toolName === 'git_log' || toolName === 'git_branches') return 'tool';
  if (toolName === 'git_create_branch' || toolName === 'git_checkout' || toolName === 'git_stage' || toolName === 'git_stage_all' || toolName === 'git_commit') return 'action';
  return 'tool';
}

function activityStatus(result: AIToolResult): ActivityEvent['status'] {
  if (result.pendingApproval) return 'pending';
  return result.ok ? 'success' : 'failed';
}

function activityMessage(toolName: ToolName, result: AIToolResult): string {
  if (result.pendingApproval) return `Aguardando aprovação: ${toolName}`;
  if (result.ok) return `Concluído: ${toolName}`;
  return `Falha: ${toolName}`;
}

export function createToolActivitySnapshot(runId: string, toolCallId: string, toolName: ToolName, result: AIToolResult): ToolActivitySnapshot {
  return { type: activityType(toolName), message: activityMessage(toolName, result), status: activityStatus(result), runId, toolCallId, toolName, result };
}

export function toActivityInput(snapshot: ToolActivitySnapshot): Omit<ActivityEvent, 'id' | 'createdAt'> {
  const { result } = snapshot;
  return {
    runId: snapshot.runId,
    type: snapshot.type,
    message: snapshot.message,
    status: snapshot.status,
    toolCallId: snapshot.toolCallId,
    toolName: snapshot.toolName,
    ...(result.commandResult ? { commandResult: result.commandResult } : {}),
    ...(result.gitResult ? { gitResult: result.gitResult } : {}),
    ...(result.changes ? { changes: result.changes } : {}),
    ...(result.diffPlan ? { diffPlan: result.diffPlan } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
