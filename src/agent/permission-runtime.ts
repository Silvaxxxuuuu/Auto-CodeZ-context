import type { PermissionLevel, ToolName } from '../ai/types';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

const internalTools = new Set<ToolName>(['plan_execution', 'complete_plan_step']);
const readTools = new Set<ToolName>(['read_file', 'read_symbol', 'search_files', 'git_status', 'git_diff', 'git_log', 'git_branches']);
const safeWriteTools = new Set<ToolName>(['write_file', 'create_file', 'replace_range', 'replace_text', 'replace_symbol', 'insert_before', 'insert_after']);
const sensitiveWriteTools = new Set<ToolName>([
  'delete_file',
  'rename_file',
  'run_command',
  'git_create_branch',
  'git_checkout',
  'git_stage',
  'git_stage_all',
  'git_commit',
]);

export class PermissionRuntime {
  decide(level: PermissionLevel, tool: ToolName): PermissionDecision {
    if (internalTools.has(tool) || readTools.has(tool)) return 'allow';
    if (level === 'read-only') return 'deny';
    if (sensitiveWriteTools.has(tool)) return level === 'unrestricted' ? 'allow' : 'ask';
    if (safeWriteTools.has(tool)) return level === 'ask' ? 'ask' : 'allow';
    return 'deny';
  }

  isWriteTool(tool: ToolName): boolean {
    return safeWriteTools.has(tool) || sensitiveWriteTools.has(tool);
  }
}
