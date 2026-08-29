import type { PermissionLevel, ToolName } from '../ai/types';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

const readTools = new Set<ToolName>(['read_file', 'search_files']);
const safeWriteTools = new Set<ToolName>(['write_file', 'create_file']);
const sensitiveWriteTools = new Set<ToolName>(['delete_file', 'rename_file', 'run_command']);

export class PermissionRuntime {
  decide(level: PermissionLevel, tool: ToolName): PermissionDecision {
    if (readTools.has(tool)) return 'allow';
    if (level === 'read-only') return 'deny';
    if (sensitiveWriteTools.has(tool)) return level === 'unrestricted' ? 'allow' : 'ask';
    if (safeWriteTools.has(tool)) return level === 'ask' ? 'ask' : 'allow';
    return 'deny';
  }

  isWriteTool(tool: ToolName): boolean {
    return safeWriteTools.has(tool) || sensitiveWriteTools.has(tool);
  }
}
