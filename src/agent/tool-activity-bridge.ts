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

function commandLabel(result: AIToolResult): string | undefined {
  const command = result.commandResult?.command.trim();
  if (!command) return undefined;
  return command.length > 90 ? `${command.slice(0, 87)}...` : command;
}

function changeLabel(result: AIToolResult): string | undefined {
  const changes = result.changes ?? result.diffPlan?.changes;
  if (!changes?.length) return undefined;
  if (changes.length === 1) return changes[0].path;
  return `${changes.length} arquivos`;
}

function activityMessage(toolName: ToolName, result: AIToolResult): string {
  if (result.pendingApproval) return 'Aguardando sua aprovação.';
  if (!result.ok) return `Falha ao executar ${toolName}.`;
  if (toolName === 'run_command') {
    const command = commandLabel(result);
    return command ? `Executado: ${command}` : 'Comando concluído.';
  }
  const changed = changeLabel(result);
  if (changed) return `${toolName === 'read_file' ? 'Lido' : 'Atualizado'}: ${changed}`;
  if (toolName === 'search_files') return 'Pesquisa concluída.';
  if (toolName.startsWith('git_')) return 'Operação Git concluída.';
  return 'Operação concluída.';
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
