import type { ToolName, AIToolCall, AIToolResult, ApprovalRequest, FileDiff, DiffPlan, CommandResultSummary, GitOperationSummary, AIMessage, PermissionLevel, ActivityEvent } from '../ai/types';
import type { LocalStorage } from '../core/storage';
import type { WorkspaceRuntime } from './workspace-runtime';
import type { PermissionRuntime } from './permission-runtime';
import type { ApprovalRuntime } from './approval-runtime';
import type { CommandRuntime } from './command-runtime';
import type { DiffRuntime } from './diff-runtime';
import type { GitRuntime } from './git-runtime';
import type { GitService } from './git-service';
import type { ActivityRuntime } from './activity-runtime';

const JOURNAL_FILE = 'tool-approval-journal.json';

type ToolExecution = Omit<AIToolResult, 'toolCallId'>;
type ApprovalEntry = ApprovalRequest & { toolCall: AIToolCall };

export class ToolRuntime {
  private readonly journal = new Map<string, ApprovalEntry>();
  private journalWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: WorkspaceRuntime,
    private readonly permissions: PermissionRuntime,
    private readonly approvals: ApprovalRuntime,
    private readonly commands: CommandRuntime,
    private readonly diffs: DiffRuntime,
    private readonly git: GitRuntime,
    private readonly gitService: GitService,
    private readonly storage: LocalStorage,
    private readonly activity: ActivityRuntime,
  ) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<ApprovalEntry[]>(JOURNAL_FILE);
    for (const entry of stored || []) this.journal.set(entry.id, entry);
    await this.reconcileJournal();
  }

  async execute(projectId: string, permission: PermissionLevel, call: AIToolCall): Promise<AIToolResult> {
    const requiresWrite = this.permissions.isWriteTool(call.name);
    const decision = this.permissions.decide(permission, call.name);
    if (!decision.allowed) return { toolCallId: call.id, ok: false, error: decision.reason };
    if (requiresWrite && decision.requiresApproval) {
      const approval = this.approvals.create({ projectId, permissionLevel: permission, toolCall: call });
      this.journal.set(approval.id, approval);
      await this.persistJournal();
      return { toolCallId: call.id, ok: true, pendingApproval: true, approvalId: approval.id, diffPlan: approval.diffPlan };
    }
    try {
      const result = await this.executeAllowed(projectId, call.name, call.input);
      return { toolCallId: call.id, ok: true, ...result };
    } catch (error) {
      return { toolCallId: call.id, ok: false, error: error instanceof Error ? error.message : 'Falha na ferramenta.' };
    }
  }

  async approve(approvalId: string): Promise<AIToolResult> {
    const approval = this.approvals.get(approvalId);
    if (!approval) return { toolCallId: approvalId, ok: false, error: 'Aprovação não encontrada.' };
    const decision = this.approvals.approve(approvalId);
    if (!decision) return { toolCallId: approval.toolCall.id, ok: false, error: 'Aprovação inválida.' };
    try {
      const result = await this.executeAllowed(approval.projectId, approval.toolCall.name, approval.toolCall.input);
      this.approvals.resolve(approvalId);
      this.journal.delete(approvalId);
      await this.persistJournal();
      return { toolCallId: approval.toolCall.id, ok: true, ...result };
    } catch (error) {
      return { toolCallId: approval.toolCall.id, ok: false, error: error instanceof Error ? error.message : 'Falha na execução aprovada.' };
    }
  }

  deny(approvalId: string): boolean {
    const denied = this.approvals.deny(approvalId);
    if (denied) {
      this.journal.delete(approvalId);
      void this.persistJournal();
    }
    return denied;
  }

  listApprovals(): ApprovalRequest[] {
    return this.approvals.list();
  }

  listTools(): ToolName[] {
    return ['read_file', 'write_file', 'create_file', 'delete_file', 'rename_file', 'search_files', 'run_command', 'git_status', 'git_diff', 'git_log', 'git_branches', 'git_create_branch', 'git_checkout', 'git_stage', 'git_stage_all', 'git_commit'];
  }

  private async matchesExpectedState(entry: ApprovalEntry): Promise<boolean> {
    if (!entry.diffPlan) return false;
    for (const change of entry.diffPlan.changes) {
      if (change.type === 'created') {
        if (await this.workspace.exists(entry.projectId, change.path)) return true;
      } else if (change.type === 'deleted') {
        if (!(await this.workspace.exists(entry.projectId, change.path))) return true;
      } else if (await this.workspace.exists(entry.projectId, change.path)) {
        const current = await this.workspace.readFile(entry.projectId, change.path);
        if (current === change.after) return true;
      }
    }
    return false;
  }

  private async reconcileJournal(): Promise<void> {
    for (const [approvalId, entry] of this.journal) {
      if (await this.matchesExpectedState(entry)) this.activity.emit({ type: 'action', message: `Operação ${approvalId} concluída durante uma interrupção anterior.`, status: 'success', toolCallId: entry.toolCall.id, toolName: entry.toolCall.name, diffPlan: entry.diffPlan });
    }
    await this.persistJournal();
  }

  private async persistJournal(): Promise<void> {
    if (!this.storage) return;
    const snapshot = [...this.journal.values()];
    const write = this.journalWrite.then(() => this.storage.write(JOURNAL_FILE, snapshot));
    this.journalWrite = write.catch((): void => undefined);
    await write;
  }

  private async executeAllowed(projectId: string, name: ToolName, input: Record<string, unknown>): Promise<ToolExecution> {
    switch (name) {
      case 'read_file': return { output: await this.workspace.readFile(projectId, this.stringValue(input, 'path')) };
      case 'write_file': {
        const path = this.stringValue(input, 'path');
        if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
        const before = await this.workspace.readFile(projectId, path);
        const after = this.stringValue(input, 'content');
        const diffPlan = this.diffs.createPlan([{ path, type: 'modified', before, after, addedLines: this.lineDelta(after, before), removedLines: this.lineDelta(before, after) }]);
        return { output: `Alteração preparada para ${path}.`, changes: diffPlan.changes, diffPlan };
      }
      case 'create_file': {
        const path = this.stringValue(input, 'path');
        if (await this.workspace.exists(projectId, path)) throw new Error('O arquivo já existe. Use write_file para alterá-lo.');
        const after = this.stringValue(input, 'content');
        const diffPlan = this.diffs.createPlan([{ path, type: 'created', before: '', after, addedLines: this.lineCount(after), removedLines: 0 }]);
        return { output: `Criação preparada para ${path}.`, changes: diffPlan.changes, diffPlan };
      }
      case 'delete_file': {
        const path = this.stringValue(input, 'path');
        const before = await this.workspace.readFile(projectId, path);
        const diffPlan = this.diffs.createPlan([{ path, type: 'deleted', before, after: '', addedLines: 0, removedLines: this.lineCount(before) }]);
        return { output: `Exclusão preparada para ${path}.`, changes: diffPlan.changes, diffPlan };
      }
      case 'rename_file': {
        const from = this.stringValue(input, 'from');
        const to = this.stringValue(input, 'to');
        const before = await this.workspace.readFile(projectId, from);
        const diffPlan = this.diffs.createPlan([{ path: to, type: 'renamed', before, after: before, addedLines: 0, removedLines: 0, renamedFrom: from }]);
        return { output: `Renomeação preparada de ${from} para ${to}.`, changes: diffPlan.changes, diffPlan };
      }
      case 'search_files': return { output: await this.workspace.search(projectId, this.stringValue(input, 'query')) };
      case 'run_command': return { commandResult: await this.commands.run(projectId, this.stringValue(input, 'command')) };
      case 'git_status': return { output: JSON.stringify(await this.git.status(projectId)) };
      case 'git_diff': return { output: await this.git.diff(projectId) };
      case 'git_log': return { output: JSON.stringify(await this.git.log({ projectId, limit: Number(input.limit || 8) })) };
      case 'git_branches': return { output: JSON.stringify(await this.git.branches(projectId)) };
      case 'git_create_branch': return { gitResult: await this.gitService.createBranch({ projectId, name: this.stringValue(input, 'name') }) };
      case 'git_checkout': return { gitResult: await this.gitService.checkout({ projectId, name: this.stringValue(input, 'name') }) };
      case 'git_stage': return { gitResult: await this.gitService.stage({ projectId, paths: this.stringArray(input, 'paths') }) };
      case 'git_stage_all': return { gitResult: await this.gitService.stageAll({ projectId }) };
      case 'git_commit': return { gitResult: await this.gitService.commit({ projectId, message: this.stringValue(input, 'message') }) };
      default: throw new Error(`Ferramenta não suportada: ${name}`);
    }
  }

  private stringValue(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Parâmetro ${key} inválido.`);
    return value;
  }

  private stringArray(input: Record<string, unknown>, key: string): string[] {
    const value = input[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`Parâmetro ${key} inválido.`);
    return value as string[];
  }

  private lineCount(value: string): number { return value ? value.split(/\r?\n/).length : 0; }
  private lineDelta(after: string, before: string): number { return Math.max(0, this.lineCount(after) - this.lineCount(before)); }
}
