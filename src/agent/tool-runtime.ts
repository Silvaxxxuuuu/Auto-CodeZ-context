import type { AIToolCall, AIToolDefinition, AIToolResult, PermissionLevel, ToolName } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { PermissionRuntime } from './permission-runtime';
import { WorkspaceRuntime } from './workspace-runtime';

const definitions: AIToolDefinition[] = [
  { name: 'read_file', description: 'Read a text file inside the active workspace.', requiresWriteAccess: false, requiresApproval: false },
  { name: 'write_file', description: 'Replace the contents of an existing file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'create_file', description: 'Create a new file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'delete_file', description: 'Delete a file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'rename_file', description: 'Rename or move a file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'search_files', description: 'Search workspace file names.', requiresWriteAccess: false, requiresApproval: false },
];

export class ToolRuntime {
  constructor(
    private readonly workspace: WorkspaceRuntime,
    private readonly permissions = new PermissionRuntime(),
    private readonly activity = new ActivityRuntime(),
  ) {}

  listDefinitions(): AIToolDefinition[] {
    return definitions.map((definition) => ({ ...definition }));
  }

  async execute(projectId: string, permission: PermissionLevel, call: AIToolCall): Promise<AIToolResult> {
    const decision = this.permissions.decide(permission, call.name);
    if (decision === 'deny') return { toolCallId: call.id, ok: false, error: 'Operação bloqueada pelas permissões do chat.' };
    if (decision === 'ask') return { toolCallId: call.id, ok: false, error: 'Operação requer aprovação do usuário.' };

    const activity = this.activity.start('tool', `Executando ${call.name}`);
    try {
      const output = await this.executeAllowed(projectId, call.name, call.input);
      this.activity.success('tool', `Concluído: ${call.name}`);
      return { toolCallId: call.id, ok: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('tool', `Falha em ${call.name}: ${message}`);
      return { toolCallId: call.id, ok: false, error: message };
    } finally {
      void activity;
    }
  }

  private async executeAllowed(projectId: string, name: ToolName, input: Record<string, unknown>): Promise<string> {
    const stringValue = (key: string): string => {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Parâmetro '${key}' inválido.`);
      return value;
    };

    switch (name) {
      case 'read_file':
        return this.workspace.readFile(projectId, stringValue('path'));
      case 'write_file':
        await this.workspace.writeFile(projectId, stringValue('path'), stringValue('content'));
        return 'Arquivo atualizado.';
      case 'create_file':
        await this.workspace.createFile(projectId, stringValue('path'), String(input.content ?? ''));
        return 'Arquivo criado.';
      case 'delete_file':
        await this.workspace.deleteFile(projectId, stringValue('path'));
        return 'Arquivo excluído.';
      case 'rename_file':
        await this.workspace.renameFile(projectId, stringValue('from'), stringValue('to'));
        return 'Arquivo renomeado.';
      case 'search_files':
        return JSON.stringify(await this.workspace.searchFiles(projectId, stringValue('query')));
    }
  }
}
