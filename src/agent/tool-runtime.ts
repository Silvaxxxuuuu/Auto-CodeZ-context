import type { ApprovalRequest, AIToolCall, AIToolDefinition, AIToolResult, FileDiff, PermissionLevel, ToolName } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ApprovalRuntime } from './approval-runtime';
import { PermissionRuntime } from './permission-runtime';
import { WorkspaceRuntime } from './workspace-runtime';
import { CommandRuntime } from './command-runtime';
import { DiffRuntime } from './diff-runtime';

const definitions: AIToolDefinition[] = [
  { name: 'read_file', description: 'Read a text file inside the active workspace.', requiresWriteAccess: false, requiresApproval: false },
  { name: 'write_file', description: 'Replace the contents of an existing file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'create_file', description: 'Create a new file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'delete_file', description: 'Delete a file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'rename_file', description: 'Rename or move a file inside the active workspace.', requiresWriteAccess: true, requiresApproval: true },
  { name: 'search_files', description: 'Search workspace file names.', requiresWriteAccess: false, requiresApproval: false },
  { name: 'run_command', description: 'Run an approved package script such as tests, build, typecheck or lint inside the active workspace.', requiresWriteAccess: false, requiresApproval: true },
];

interface ToolExecution {
  output: string;
  changes?: FileDiff[];
}

export class ToolRuntime {
  constructor(
    private readonly workspace: WorkspaceRuntime,
    private readonly permissions = new PermissionRuntime(),
    private readonly activity = new ActivityRuntime(),
    private readonly approvals = new ApprovalRuntime(),
    private readonly commands = new CommandRuntime(async () => []),
    private readonly diffs = new DiffRuntime(),
  ) {}

  listDefinitions(): AIToolDefinition[] { return definitions.map((definition) => ({ ...definition })); }
  listApprovals(): ApprovalRequest[] { return this.approvals.list(); }

  async execute(projectId: string, permission: PermissionLevel, call: AIToolCall): Promise<AIToolResult> {
    const decision = this.permissions.decide(permission, call.name);
    if (decision === 'deny') return { toolCallId: call.id, ok: false, error: 'Operação bloqueada pelas permissões do chat.' };
    if (decision === 'ask') {
      const approval = this.approvals.request({ projectId, permissionLevel: permission, toolCall: call });
      this.activity.emit({ type: 'action', message: `Aguardando aprovação para ${call.name}.`, status: 'pending' });
      return { toolCallId: call.id, ok: false, error: 'Operação requer aprovação do usuário.', approvalId: approval.id, pendingApproval: true };
    }
    return this.executeNow(projectId, call);
  }

  async approve(approvalId: string): Promise<AIToolResult> {
    const approval = this.approvals.resolve(approvalId);
    return this.executeNow(approval.projectId, approval.toolCall);
  }

  deny(approvalId: string): boolean {
    if (!this.approvals.get(approvalId)) return false;
    this.approvals.resolve(approvalId);
    this.activity.emit({ type: 'action', message: 'Operação recusada pelo usuário.', status: 'success' });
    return true;
  }

  private async executeNow(projectId: string, call: AIToolCall): Promise<AIToolResult> {
    this.activity.start('tool', `Executando ${call.name}`);
    try {
      const execution = await this.executeAllowed(projectId, call.name, call.input);
      this.activity.success('tool', `Concluído: ${call.name}`);
      return { toolCallId: call.id, ok: true, output: execution.output, changes: execution.changes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('tool', `Falha em ${call.name}: ${message}`);
      return { toolCallId: call.id, ok: false, error: message };
    }
  }

  private async executeAllowed(projectId: string, name: ToolName, input: Record<string, unknown>): Promise<ToolExecution> {
    const stringValue = (key: string): string => {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Parâmetro '${key}' inválido.`);
      return value;
    };

    switch (name) {
      case 'read_file':
        return { output: await this.workspace.readFile(projectId, stringValue('path')) };
      case 'write_file': {
        const requestedPath = stringValue('path');
        if (!(await this.workspace.exists(projectId, requestedPath))) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
        const before = await this.workspace.readFile(projectId, requestedPath);
        const content = stringValue('content');
        await this.workspace.writeFile(projectId, requestedPath, content);
        const after = await this.workspace.readFile(projectId, requestedPath);
        return { output: 'Arquivo atualizado.', changes: [this.diffs.create(requestedPath, 'modified', before, after)] };
      }
      case 'create_file': {
        const requestedPath = stringValue('path');
        const content = String(input.content ?? '');
        await this.workspace.createFile(projectId, requestedPath, content);
        const after = await this.workspace.readFile(projectId, requestedPath);
        return { output: 'Arquivo criado.', changes: [this.diffs.create(requestedPath, 'created', '', after)] };
      }
      case 'delete_file': {
        const requestedPath = stringValue('path');
        const before = await this.workspace.readFile(projectId, requestedPath);
        await this.workspace.deleteFile(projectId, requestedPath);
        return { output: 'Arquivo excluído.', changes: [this.diffs.create(requestedPath, 'deleted', before, '')] };
      }
      case 'rename_file': {
        const from = stringValue('from');
        const to = stringValue('to');
        const before = await this.workspace.readFile(projectId, from);
        await this.workspace.renameFile(projectId, from, to);
        const after = await this.workspace.readFile(projectId, to);
        return { output: 'Arquivo renomeado.', changes: [this.diffs.create(to, 'renamed', before, after, from)] };
      }
      case 'search_files':
        return { output: JSON.stringify(await this.workspace.searchFiles(projectId, stringValue('query'))) };
      case 'run_command':
        return { output: JSON.stringify(await this.commands.run(projectId, stringValue('manager'), stringValue('script'))) };
    }
  }
}
