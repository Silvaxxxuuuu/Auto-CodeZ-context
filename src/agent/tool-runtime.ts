import type { ApprovalRequest, AIToolCall, AIToolDefinition, AIToolResult, DiffPlan, FileDiff, PermissionLevel, ToolName } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ApprovalRuntime } from './approval-runtime';
import { PermissionRuntime } from './permission-runtime';
import { WorkspaceRuntime } from './workspace-runtime';
import { CommandRuntime } from './command-runtime';
import { DiffRuntime } from './diff-runtime';

const definitions: AIToolDefinition[] = [
  { name: 'read_file', description: 'Read a UTF-8 text file inside the active workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'write_file', description: 'Replace the contents of an existing UTF-8 text file inside the active workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Complete replacement file contents.' } }, required: ['path', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'create_file', description: 'Create a new UTF-8 text file inside the active workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Initial file contents.' } }, required: ['path', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'delete_file', description: 'Delete a file inside the active workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'rename_file', description: 'Rename or move a file inside the active workspace.', parameters: { type: 'object', properties: { from: { type: 'string', description: 'Current workspace-relative path.' }, to: { type: 'string', description: 'Destination workspace-relative path.' } }, required: ['from', 'to'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'search_files', description: 'Search workspace file names for a text query.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for in workspace file names.' } }, required: ['query'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'run_command', description: 'Run an approved package script such as tests, build, typecheck or lint inside the active workspace.', parameters: { type: 'object', properties: { manager: { type: 'string', enum: ['npm', 'pnpm', 'yarn', 'bun'] }, script: { type: 'string', enum: ['test', 'build', 'typecheck', 'lint', 'package', 'check'] } }, required: ['manager', 'script'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: true },
];

interface ToolExecution { output: string; changes?: FileDiff[]; }

interface ToolJournalStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

type JournalEntry = {
  approvalId: string;
  projectId: string;
  toolCall: AIToolCall;
  diffPlan: DiffPlan;
  status: 'executing';
};

const JOURNAL_FILE = 'tool-execution-journal.json';

function validateToolInput(definition: AIToolDefinition, input: Record<string, unknown>): void {
  const schema = definition.parameters;
  if (schema.type !== 'object' || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Entrada inválida para ${definition.name}.`);
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) if (!(key in input)) throw new Error(`Parâmetro obrigatório ausente: '${key}'.`);
  if (schema.additionalProperties === false) {
    const properties = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties as Record<string, unknown>) : [];
    for (const key of Object.keys(input)) if (!properties.includes(key)) throw new Error(`Parâmetro não permitido: '${key}'.`);
  }
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, Record<string, unknown>> : {};
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!property) continue;
    if (property.type === 'string' && typeof value !== 'string') throw new Error(`Parâmetro '${key}' deve ser texto.`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new Error(`Valor inválido para '${key}'.`);
  }
}

const unavailableCommandRuntime = new CommandRuntime(async () => {
  throw new Error('O runtime de comandos não foi configurado para esta instância.');
});

export class ToolRuntime {
  private readonly journal = new Map<string, JournalEntry>();
  private journalWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: WorkspaceRuntime,
    private readonly permissions = new PermissionRuntime(),
    private readonly activity = new ActivityRuntime(),
    private readonly approvals = new ApprovalRuntime(),
    private readonly commands: CommandRuntime = unavailableCommandRuntime,
    private readonly diffs = new DiffRuntime(),
    private readonly journalStorage?: ToolJournalStorage,
  ) {}

  async init(): Promise<void> {
    if (!this.journalStorage) return;
    const stored = await this.journalStorage.read<JournalEntry[]>(JOURNAL_FILE, []);
    this.journal.clear();
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
      if (!entry?.approvalId || !entry.projectId || !entry.toolCall?.id || !entry.diffPlan?.changes?.length) continue;
      this.journal.set(entry.approvalId, entry);
    }
    await this.reconcileJournal();
  }

  listDefinitions(): AIToolDefinition[] { return definitions.map((definition) => ({ ...definition, parameters: { ...definition.parameters } })); }
  listApprovals(): ApprovalRequest[] { return this.approvals.list(); }
  restoreApprovals(approvals: ApprovalRequest[]): void { this.approvals.restore(approvals); }

  async execute(projectId: string, permission: PermissionLevel, call: AIToolCall): Promise<AIToolResult> {
    const definition = definitions.find((item) => item.name === call.name);
    if (!definition) return { toolCallId: call.id, ok: false, error: `Ferramenta desconhecida: ${call.name}` };
    try { validateToolInput(definition, call.input); }
    catch (error) { return { toolCallId: call.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }

    const decision = this.permissions.decide(permission, call.name);
    if (decision === 'deny') return { toolCallId: call.id, ok: false, error: 'Operação bloqueada pelas permissões do chat.' };

    if (decision === 'ask') {
      try {
        const diffPlan = await this.preview(projectId, call);
        const approval = this.approvals.request({ projectId, permissionLevel: permission, toolCall: call, ...(diffPlan ? { diffPlan } : {}) });
        this.activity.emit({ type: 'action', message: `Aguardando aprovação para ${call.name}.`, status: 'pending' });
        return { toolCallId: call.id, ok: false, error: 'Operação requer aprovação do usuário.', approvalId: approval.id, pendingApproval: true, ...(diffPlan ? { diffPlan } : {}) };
      } catch (error) {
        return { toolCallId: call.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return this.executeNow(projectId, call);
  }

  async approve(approvalId: string): Promise<AIToolResult> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error('Aprovação não encontrada ou já processada.');
    try {
      await this.assertPrecondition(approval.projectId, approval.diffPlan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('tool', `Aprovação ${approvalId} não pôde ser executada: ${message}`);
      return { toolCallId: approval.toolCall.id, ok: false, error: message, approvalId, pendingApproval: true, ...(approval.diffPlan ? { diffPlan: approval.diffPlan } : {}) };
    }

    const journalResult = await this.getCompletedJournalResult(approvalId, approval);
    if (journalResult) {
      this.approvals.resolve(approvalId);
      return journalResult;
    }

    const result = await this.executeNow(approval.projectId, approval.toolCall, approvalId, approval.diffPlan);
    if (result.ok) this.approvals.resolve(approvalId);
    else return { ...result, approvalId, pendingApproval: true, ...(approval.diffPlan ? { diffPlan: approval.diffPlan } : {}) };
    return result;
  }

  deny(approvalId: string): boolean {
    if (!this.approvals.get(approvalId)) return false;
    this.approvals.resolve(approvalId);
    this.activity.emit({ type: 'action', message: 'Operação recusada pelo usuário.', status: 'failed' });
    return true;
  }

  private async preview(projectId: string, call: AIToolCall): Promise<DiffPlan | undefined> {
    switch (call.name) {
      case 'write_file': {
        const path = this.stringValue(call.input, 'path');
        if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
        const before = await this.workspace.readFile(projectId, path);
        const content = call.input.content;
        if (typeof content !== 'string') throw new Error("Parâmetro 'content' inválido.");
        return this.diffs.createPlan([this.diffs.create(path, 'modified', before, content)]);
      }
      case 'create_file': {
        const path = this.stringValue(call.input, 'path');
        if (await this.workspace.exists(projectId, path)) throw new Error('O arquivo já existe. Use write_file para substituí-lo.');
        const content = String(call.input.content ?? '');
        return this.diffs.createPlan([this.diffs.create(path, 'created', '', content)]);
      }
      case 'delete_file': {
        const path = this.stringValue(call.input, 'path');
        const before = await this.workspace.readFile(projectId, path);
        return this.diffs.createPlan([this.diffs.create(path, 'deleted', before, '')]);
      }
      case 'rename_file': {
        const from = this.stringValue(call.input, 'from');
        const to = this.stringValue(call.input, 'to');
        const before = await this.workspace.readFile(projectId, from);
        if (await this.workspace.exists(projectId, to)) throw new Error('O destino da renomeação já existe.');
        return this.diffs.createPlan([this.diffs.create(to, 'renamed', before, before, from)]);
      }
      default:
        return undefined;
    }
  }

  private async assertPrecondition(projectId: string, plan?: DiffPlan): Promise<void> {
    if (!plan) return;
    for (const change of plan.changes) {
      if (change.type === 'created') {
        if (await this.workspace.exists(projectId, change.path)) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
        continue;
      }
      if (change.type === 'renamed') {
        const from = change.renamedFrom;
        if (!from || !(await this.workspace.exists(projectId, from)) || await this.workspace.exists(projectId, change.path)) throw new Error(`A renomeação de '${from || '?'}' para '${change.path}' não corresponde mais ao estado aprovado.`);
        const current = await this.workspace.readFile(projectId, from);
        if (current !== change.before) throw new Error(`O arquivo '${from}' mudou desde a aprovação.`);
        continue;
      }
      if (!(await this.workspace.exists(projectId, change.path))) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
      const current = await this.workspace.readFile(projectId, change.path);
      if (current !== change.before) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
    }
  }

  private stringValue(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Parâmetro '${key}' inválido.`);
    return value;
  }

  private async executeNow(projectId: string, call: AIToolCall, approvalId?: string, diffPlan?: DiffPlan): Promise<AIToolResult> {
    this.activity.start('tool', `Executando ${call.name}`);
    try {
      if (approvalId && diffPlan && this.isMutation(call.name)) await this.beginJournal(approvalId, projectId, call, diffPlan);
      const execution = await this.executeAllowed(projectId, call.name, call.input);
      this.activity.success('tool', `Concluído: ${call.name}`);
      const result: AIToolResult = { toolCallId: call.id, ok: true, output: execution.output, changes: execution.changes };
      if (approvalId) await this.finishJournal(approvalId);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('tool', `Falha em ${call.name}: ${message}`);
      return { toolCallId: call.id, ok: false, error: message };
    }
  }

  private isMutation(name: ToolName): boolean {
    return name === 'write_file' || name === 'create_file' || name === 'delete_file' || name === 'rename_file';
  }

  private async beginJournal(approvalId: string, projectId: string, toolCall: AIToolCall, diffPlan: DiffPlan): Promise<void> {
    if (!this.journalStorage) return;
    if (!this.journal.has(approvalId)) {
      this.journal.set(approvalId, { approvalId, projectId, toolCall, diffPlan, status: 'executing' });
      await this.persistJournal();
    }
  }

  private async finishJournal(approvalId: string): Promise<void> {
    if (!this.journalStorage) return;
    this.journal.delete(approvalId);
    await this.persistJournal();
  }

  private async getCompletedJournalResult(approvalId: string, approval: ApprovalRequest): Promise<AIToolResult | undefined> {
    const entry = this.journal.get(approvalId);
    if (!entry) return undefined;
    const completed = await this.matchesExpectedState(entry);
    if (!completed) return undefined;
    const result = await this.buildJournalResult(entry);
    await this.finishJournal(approvalId);
    return result;
  }

  private async buildJournalResult(entry: JournalEntry): Promise<AIToolResult> {
    const changes: FileDiff[] = [];
    for (const change of entry.diffPlan.changes) {
      let after = change.after;
      if (change.type !== 'deleted') after = await this.workspace.readFile(entry.projectId, change.path);
      changes.push(this.diffs.create(change.path, change.type, change.before, after, change.renamedFrom));
    }
    return { toolCallId: entry.toolCall.id, ok: true, output: 'Operação concluída após recuperação do journal.', changes };
  }

  private async matchesExpectedState(entry: JournalEntry): Promise<boolean> {
    for (const change of entry.diffPlan.changes) {
      if (change.type === 'deleted') {
        if (await this.workspace.exists(entry.projectId, change.path)) return false;
        continue;
      }
      if (change.type === 'renamed') {
        const from = change.renamedFrom;
        if (!from || await this.workspace.exists(entry.projectId, from) || !(await this.workspace.exists(entry.projectId, change.path))) return false;
        if (await this.workspace.readFile(entry.projectId, change.path) !== change.after) return false;
        continue;
      }
      if (!(await this.workspace.exists(entry.projectId, change.path))) return false;
      if (await this.workspace.readFile(entry.projectId, change.path) !== change.after) return false;
    }
    return true;
  }

  private async reconcileJournal(): Promise<void> {
    for (const [approvalId, entry] of this.journal) {
      if (await this.matchesExpectedState(entry)) this.activity.emit({ type: 'action', message: `Operação ${approvalId} concluída durante uma interrupção anterior.`, status: 'success' });
    }
    await this.persistJournal();
  }

  private async persistJournal(): Promise<void> {
    if (!this.journalStorage) return;
    const snapshot = [...this.journal.values()];
    const write = this.journalWrite.then(() => this.journalStorage!.write(JOURNAL_FILE, snapshot));
    this.journalWrite = write.catch(() => undefined);
    await write;
  }

  private async executeAllowed(projectId: string, name: ToolName, input: Record<string, unknown>): Promise<ToolExecution> {
    switch (name) {
      case 'read_file': return { output: await this.workspace.readFile(projectId, this.stringValue(input, 'path')) };
      case 'write_file': {
        const path = this.stringValue(input, 'path');
        if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
        const before = await this.workspace.readFile(projectId, path);
        const content = input.content;
        if (typeof content !== 'string') throw new Error("Parâmetro 'content' inválido.");
        await this.workspace.writeFile(projectId, path, content);
        const after = await this.workspace.readFile(projectId, path);
        return { output: 'Arquivo atualizado.', changes: [this.diffs.create(path, 'modified', before, after)] };
      }
      case 'create_file': {
        const path = this.stringValue(input, 'path');
        const content = String(input.content ?? '');
        await this.workspace.createFile(projectId, path, content);
        const after = await this.workspace.readFile(projectId, path);
        return { output: 'Arquivo criado.', changes: [this.diffs.create(path, 'created', '', after)] };
      }
      case 'delete_file': {
        const path = this.stringValue(input, 'path');
        const before = await this.workspace.readFile(projectId, path);
        await this.workspace.deleteFile(projectId, path);
        return { output: 'Arquivo excluído.', changes: [this.diffs.create(path, 'deleted', before, '')] };
      }
      case 'rename_file': {
        const from = this.stringValue(input, 'from');
        const to = this.stringValue(input, 'to');
        const before = await this.workspace.readFile(projectId, from);
        await this.workspace.renameFile(projectId, from, to);
        const after = await this.workspace.readFile(projectId, to);
        return { output: 'Arquivo renomeado.', changes: [this.diffs.create(to, 'renamed', before, after, from)] };
      }
      case 'search_files': return { output: JSON.stringify(await this.workspace.searchFiles(projectId, this.stringValue(input, 'query'))) };
      case 'run_command': return { output: JSON.stringify(await this.commands.run(projectId, this.stringValue(input, 'manager'), this.stringValue(input, 'script'))) };
    }
  }
}
