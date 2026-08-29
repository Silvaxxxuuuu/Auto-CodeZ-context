import type { PermissionLevel, ToolName } from '../ai/types';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

const readTools = new Set<ToolName>(['read_file', 'search_files']);
const writeTools = new Set<ToolName>(['write_file', 'create_file', 'delete_file', 'rename_file']);

export class PermissionRuntime {
  decide(level: PermissionLevel, tool: ToolName): PermissionDecision {
    if (readTools.has(tool)) return 'allow';
    if (!writeTools.has(tool)) return 'deny';
    if (level === 'read-only') return 'deny';
    if (level === 'safe') return 'allow';
    if (level === 'ask') return 'ask';
    return 'allow';
  }

  isWriteTool(tool: ToolName): boolean {
    return writeTools.has(tool);
  }
}
