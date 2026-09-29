import type { ApprovalRequest, AIToolCall, AIToolDefinition, AIToolResult, CommandResultSummary, DiffPlan, FileDiff, PermissionLevel, ToolName } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ApprovalRuntime } from './approval-runtime';
import { PermissionRuntime } from './permission-runtime';
import { WorkspacePathPolicy } from './workspace-path-policy';
import { CommandSafetyPolicy } from './command-safety-policy';
import { extractToolPolicyPaths, ToolPolicyRuntime, type ToolPolicyResult } from './tool-policy-runtime';
import { WorkspaceRuntime } from './workspace-runtime';
import { CommandRuntime } from './command-runtime';
import { ProcessRuntime } from './process-runtime';
import { DiffRuntime } from './diff-runtime';
import { GitRuntime } from './git-runtime';
import { applyIncrementalEdit, type IncrementalEditToolName } from './incremental-file-edit';
import { StructuralEditRuntime, type StructuralSymbolKind } from './structural-edit-runtime';
import { TypeScriptStructuralLocator } from './typescript-structural-locator';
import { ExecutionPlanner, type ExecutionPlan } from '../execution-planner';
import { ExecutionChangeBudgetRuntime, type ExecutionChangeBudget, type ExecutionChangeUsage } from '../execution-change-budget';
import { ExecutionPathScopeRuntime, type ExecutionPathScopeSnapshot } from '../execution-path-scope';
import type { IncrementalWorkspaceMutationRuntime } from '../agent-core/incremental-workspace-runtime';

const realWorkspaceTextMutationTools = new Set<ToolName>([
  'write_file',
  'replace_range',
  'replace_text',
  'replace_symbol',
  'delete_file',
  'insert_before',
  'insert_after',
]);

function isRealWorkspaceTextMutation(name: ToolName): boolean {
  return realWorkspaceTextMutationTools.has(name);
}

const definitions: AIToolDefinition[] = [
  { name: 'plan_execution', description: 'Declare a concrete execution plan for a multi-step task. Auto CodeZ starts the first step immediately. Use this before substantial multi-step tool work, then execute real tools and call complete_plan_step only after the current step has runtime-recorded evidence.', parameters: { type: 'object', properties: { objective: { type: 'string', description: 'Concrete objective of this execution.' }, steps: { type: 'array', items: { type: 'string' }, description: 'Ordered, concise execution steps.' } }, required: ['objective', 'steps'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'complete_plan_step', description: 'Complete the currently running execution-plan step. Auto CodeZ rejects this unless the current step already contains evidence produced by a real successful tool execution. When successful, the next pending step starts automatically.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'read_file', description: 'Read a UTF-8 text file inside the active workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'read_symbol', description: 'Read one uniquely named TypeScript or JavaScript syntax symbol using the real TypeScript AST. Supported kinds are function, method, class, interface, type and enum. Use this when only one complete named declaration is needed; ambiguity or unsupported files fail instead of guessing.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative TypeScript or JavaScript file path.' }, symbol: { type: 'string', description: 'Exact declared symbol name.' }, kind: { type: 'string', enum: ['function', 'method', 'class', 'interface', 'type', 'enum'], description: 'Declared syntax kind.' } }, required: ['path', 'symbol', 'kind'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'write_file', description: 'Replace the contents of an existing UTF-8 text file inside the active workspace. Use this only when replacing most or all of a file; prefer replace_range, insert_before or insert_after for localized edits so diffs stay small.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Complete replacement file contents.' } }, required: ['path', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'replace_range', description: 'Replace an inclusive 1-based line range in an existing UTF-8 text file. Prefer this for localized edits instead of rewriting the whole file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, startLine: { type: 'number', description: 'First 1-based line to replace.' }, endLine: { type: 'number', description: 'Last 1-based line to replace, inclusive.' }, content: { type: 'string', description: 'Replacement line content.' } }, required: ['path', 'startLine', 'endLine', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'replace_text', description: 'Replace one exact unique text fragment in an existing UTF-8 file. The oldText fragment must occur exactly once; otherwise the operation fails instead of guessing. Prefer this when you have just read the exact code to change.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, oldText: { type: 'string', description: 'Exact current text fragment. It must be unique in the file.' }, newText: { type: 'string', description: 'Replacement text, which may be empty to remove the fragment.' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'replace_symbol', description: 'Replace one uniquely named TypeScript or JavaScript syntax symbol using the real TypeScript AST. Supported kinds are function, method, class, interface, type and enum. Use this when replacing an entire named declaration; ambiguity or unsupported files fail instead of guessing.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative TypeScript or JavaScript file path.' }, symbol: { type: 'string', description: 'Exact declared symbol name.' }, kind: { type: 'string', enum: ['function', 'method', 'class', 'interface', 'type', 'enum'], description: 'Declared syntax kind.' }, content: { type: 'string', description: 'Complete replacement declaration for the selected symbol.' } }, required: ['path', 'symbol', 'kind', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'insert_before', description: 'Insert one or more lines immediately before a 1-based line in an existing UTF-8 text file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, line: { type: 'number', description: '1-based line before which content is inserted.' }, content: { type: 'string', description: 'Line content to insert.' } }, required: ['path', 'line', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'insert_after', description: 'Insert one or more lines immediately after a 1-based line in an existing UTF-8 text file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, line: { type: 'number', description: '1-based line after which content is inserted.' }, content: { type: 'string', description: 'Line content to insert.' } }, required: ['path', 'line', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'create_file', description: 'Create a new UTF-8 text file directly in the real active workspace. Missing parent directories are created automatically. Use this when the file itself is known; do not create parent folders separately just to prepare for this file. The operation is journaled and verified when Agent Core V2 incremental execution is configured.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path.' }, content: { type: 'string', description: 'Initial file contents.' } }, required: ['path', 'content'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'create_folder', description: 'Create a directory directly in the real active workspace. Use this when the directory itself is part of the requested result, must exist empty, or needs to exist before a later operation. Do not use it merely to prepare parent directories for create_file because create_file already creates them safely.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory path.' } }, required: ['path'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'delete_file', description: 'Delete a file inside the active workspace. Prefer this tool over shell commands for workspace file deletion so Auto CodeZ can preview and review the exact change.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'rename_file', description: 'Rename or move a file inside the active workspace. Prefer this tool over shell commands for workspace file renames so Auto CodeZ can preview and review the exact change.', parameters: { type: 'object', properties: { from: { type: 'string', description: 'Current workspace-relative path.' }, to: { type: 'string', description: 'Destination workspace-relative path.' } }, required: ['from', 'to'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'search_files', description: 'Search workspace file names for a text query.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for in workspace file names.' } }, required: ['query'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'start_process', description: 'Start a persistent local process from the active workspace and return a processId for later lifecycle operations. Use this for dev servers, watchers and long-running jobs. Prefer run_command for finite commands. The command passes through the same command safety policy as run_command.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Exact local shell command to start from the workspace root.' } }, required: ['command'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: true },
  { name: 'read_process_output', description: 'Read buffered stdout/stderr from a managed persistent process. Pass afterSequence=0 for the available buffer or the previous nextSequence to receive only newer events.', parameters: { type: 'object', properties: { processId: { type: 'string', description: 'Managed process identifier returned by start_process.' }, afterSequence: { type: 'number', description: 'Last consumed output sequence. Use 0 for the available buffer.' } }, required: ['processId', 'afterSequence'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'wait_process', description: 'Wait for a managed persistent process to reach a terminal state, or return its current state when timeoutMs elapses. This does not kill the process on timeout.', parameters: { type: 'object', properties: { processId: { type: 'string', description: 'Managed process identifier.' }, timeoutMs: { type: 'number', description: 'Maximum milliseconds to wait. Use 0 to poll immediately.' } }, required: ['processId', 'timeoutMs'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'stop_process', description: 'Stop a managed persistent process and its child process tree. Use this to cleanly end dev servers, watchers and other processes previously started by start_process.', parameters: { type: 'object', properties: { processId: { type: 'string', description: 'Managed process identifier.' } }, required: ['processId'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: true },
  { name: 'list_processes', description: 'List managed persistent processes belonging to the active workspace, including lifecycle state, PID, command and timestamps.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'run_command', description: 'Execute a local shell command from the active workspace. Use it for tests, builds, inspections, scripts, CLIs and operations that genuinely require a shell. Do not use it to create, edit, delete or rename workspace files when create_file, write_file, delete_file or rename_file can represent the requested result, because those file tools provide diff review and stale-file protection. Do not create workspace directories with shell commands when the requested folder will contain files. create_file automatically creates missing parent directories, so create the first file directly under the desired folder instead of running mkdir. Shell filesystem side effects execute inside an isolated command sandbox and are not a substitute for persistent Auto CodeZ file tools. In read-only mode run_command is blocked. In every other permission mode it requires explicit user approval before the process starts. Sensitive direct mutations may be blocked entirely by the command safety policy.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Exact local shell command to execute.' } }, required: ['command'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: true },
  { name: 'git_status', description: 'Read the current Git branch and working tree status.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'git_diff', description: 'Read the current unstaged Git diff.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'git_log', description: 'Read recent Git commits from the active workspace.', parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Number of commits to return.' } }, required: ['limit'], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'git_branches', description: 'List local Git branches from the active workspace.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, requiresWriteAccess: false, requiresApproval: false },
  { name: 'git_create_branch', description: 'Create and switch to a new Git branch. This operation requires user approval.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'New branch name.' } }, required: ['name'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'git_checkout', description: 'Switch the active workspace to an existing Git branch. This operation requires user approval.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Existing branch name.' } }, required: ['name'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'git_stage', description: 'Stage selected workspace files for a Git commit. This operation requires user approval.', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths to stage.' } }, required: ['paths'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'git_stage_all', description: 'Stage all Git changes in the active workspace. This operation requires user approval.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
  { name: 'git_commit', description: 'Create a Git commit from the currently staged changes. This operation requires user approval.', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Git commit message.' } }, required: ['message'], additionalProperties: false }, requiresWriteAccess: true, requiresApproval: true },
];

interface ToolExecution { output: string; changes?: FileDiff[]; commandResult?: CommandResultSummary; }
interface ToolJournalStorage { read<T>(name: string, fallback: T): Promise<T>; write<T>(name: string, value: T): Promise<void>; }
type JournalEntry = { approvalId: string; projectId: string; toolCall: AIToolCall; diffPlan: DiffPlan; status: 'executing'; };
type ExecutionCheckpointRecord = { chatId: string; runId: string; projectId: string; toolCallId: string; changes: FileDiff[] };
type ExecutionCheckpointRecorder = (record: ExecutionCheckpointRecord) => void;
const JOURNAL_FILE = 'tool-execution-journal.json';

type ActivityContext = { chatId?: string; runId?: string; toolCallId?: string };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

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
    if (property.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Parâmetro '${key}' deve ser número.`);
    if (property.type === 'array' && !Array.isArray(value)) throw new Error(`Parâmetro '${key}' deve ser uma lista.`);
    if (property.type === 'array' && Array.isArray(value) && value.some((item) => typeof item !== 'string')) throw new Error(`Parâmetro '${key}' deve conter somente textos.`);
    if (Array.isArray(property.enum) && !property.enum.includes(value)) throw new Error(`Valor inválido para '${key}'.`);
  }
}

function normalizeToolCall(call: AIToolCall): AIToolCall {
  if (call.name !== 'run_command' || typeof call.input.command === 'string') return call;
  const manager = call.input.manager;
  const script = call.input.script;
  if (typeof manager !== 'string' || typeof script !== 'string' || !manager.trim() || !script.trim()) return call;
  const command = manager.trim() === 'npm' ? `${manager.trim()} run ${script.trim()}` : `${manager.trim()} ${script.trim()}`;
  return { ...call, input: { command } };
}

const unavailableCommandRuntime = new CommandRuntime(async () => { throw new Error('O runtime de comandos não foi configurado para esta instância.'); });

function executionActivityMessage(call: AIToolCall): string {
  const value = (key: string): string | undefined => typeof call.input[key] === 'string' && String(call.input[key]).trim() ? String(call.input[key]).trim() : undefined;
  switch (call.name) {
    case 'plan_execution': return 'Criando plano de execução.';
    case 'complete_plan_step': return 'Concluindo passo do plano.';
    case 'run_command': return value('command') ? `Executando ${value('command')}` : 'Executando comando.';
    case 'start_process': return value('command') ? `Iniciando processo: ${value('command')}` : 'Iniciando processo persistente.';
    case 'read_process_output': return value('processId') ? `Lendo saída do processo ${value('processId')}` : 'Lendo saída do processo.';
    case 'wait_process': return value('processId') ? `Aguardando processo ${value('processId')}` : 'Aguardando processo.';
    case 'stop_process': return value('processId') ? `Encerrando processo ${value('processId')}` : 'Encerrando processo.';
    case 'list_processes': return 'Listando processos persistentes.';
    case 'read_file': return value('path') ? `Lendo ${value('path')}` : 'Lendo arquivo.';
    case 'read_symbol': return value('path') && value('symbol') ? `Lendo símbolo ${value('symbol')} em ${value('path')}` : 'Lendo símbolo do arquivo.';
    case 'write_file': return value('path') ? `Editando ${value('path')}` : 'Editando arquivo.';
    case 'replace_range': return value('path') ? `Editando trecho de ${value('path')}` : 'Editando trecho do arquivo.';
    case 'replace_text': return value('path') ? `Substituindo trecho exato de ${value('path')}` : 'Substituindo trecho exato do arquivo.';
    case 'replace_symbol': return value('path') && value('symbol') ? `Substituindo símbolo ${value('symbol')} em ${value('path')}` : 'Substituindo símbolo do arquivo.';
    case 'insert_before': return value('path') ? `Inserindo conteúdo em ${value('path')}` : 'Inserindo conteúdo no arquivo.';
    case 'insert_after': return value('path') ? `Inserindo conteúdo em ${value('path')}` : 'Inserindo conteúdo no arquivo.';
    case 'create_file': return value('path') ? `Criando ${value('path')}` : 'Criando arquivo.';
    case 'create_folder': return value('path') ? `Criando pasta ${value('path')}` : 'Criando pasta.';
    case 'delete_file': return value('path') ? `Excluindo ${value('path')}` : 'Excluindo arquivo.';
    case 'rename_file': return value('from') && value('to') ? `Renomeando ${value('from')} → ${value('to')}` : 'Renomeando arquivo.';
    case 'search_files': return value('query') ? `Pesquisando por ${value('query')}` : 'Pesquisando arquivos.';
    case 'git_status': return 'Consultando status do Git.';
    case 'git_diff': return 'Lendo alterações do Git.';
    case 'git_log': return 'Consultando histórico do Git.';
    case 'git_branches': return 'Consultando branches do Git.';
    case 'git_create_branch': return value('name') ? `Criando branch ${value('name')}` : 'Criando branch.';
    case 'git_checkout': return value('name') ? `Trocando para a branch ${value('name')}` : 'Trocando de branch.';
    case 'git_stage': return 'Preparando arquivos para commit.';
    case 'git_stage_all': return 'Preparando todas as alterações para commit.';
    case 'git_commit': return value('message') ? `Criando commit: ${value('message')}` : 'Criando commit.';
  }
}

export class ToolRuntime {
  private readonly journal = new Map<string, JournalEntry>();
  private journalWrite: Promise<void> = Promise.resolve();
  private gitRuntime?: GitRuntime;
  private executionPlanner?: ExecutionPlanner;
  private executionChangeBudget?: ExecutionChangeBudgetRuntime;
  private executionPathScope?: ExecutionPathScopeRuntime;
  private executionCheckpointRecorder?: ExecutionCheckpointRecorder;
  private incrementalWorkspace?: IncrementalWorkspaceMutationRuntime;
  private processRuntime?: ProcessRuntime;

  constructor(private readonly workspace: WorkspaceRuntime, permissions = new PermissionRuntime(), private readonly activity = new ActivityRuntime(), private readonly approvals = new ApprovalRuntime(), private readonly commands: CommandRuntime = unavailableCommandRuntime, private readonly diffs = new DiffRuntime(), private readonly journalStorage?: ToolJournalStorage, private readonly structuralEdits = new StructuralEditRuntime([new TypeScriptStructuralLocator()]), workspacePathPolicy = new WorkspacePathPolicy(), commandSafetyPolicy = new CommandSafetyPolicy(workspacePathPolicy), private readonly toolPolicy = new ToolPolicyRuntime(permissions, workspacePathPolicy, commandSafetyPolicy)) {}

  configureGitRuntime(runtime: GitRuntime): void { this.gitRuntime = runtime; }
  configureExecutionPlanner(runtime: ExecutionPlanner): void { this.executionPlanner = runtime; }
  configureExecutionChangeBudget(runtime: ExecutionChangeBudgetRuntime): void { this.executionChangeBudget = runtime; }
  configureExecutionPathScope(runtime: ExecutionPathScopeRuntime): void { this.executionPathScope = runtime; this.toolPolicy.configureExecutionPathScope(runtime); }
  configureExecutionCheckpointRecorder(recorder: ExecutionCheckpointRecorder): void { this.executionCheckpointRecorder = recorder; }
  configureIncrementalWorkspaceRuntime(runtime: IncrementalWorkspaceMutationRuntime): void { this.incrementalWorkspace = runtime; }
  configureProcessRuntime(runtime: ProcessRuntime): void { this.processRuntime = runtime; }
  protected hasIncrementalWorkspaceRuntime(): boolean { return Boolean(this.incrementalWorkspace); }
  protected hasProcessRuntime(): boolean { return Boolean(this.processRuntime); }
  configureChangeBudget(chatId: string, runId: string, budget: ExecutionChangeBudget): ExecutionChangeBudget {
    if (!this.executionChangeBudget) throw new Error('O runtime de Change Budget não foi configurado.');
    return this.executionChangeBudget.configure(chatId, runId, budget);
  }
  async configureExecutionAllowedPaths(chatId: string, runId: string, projectId: string, allowedPaths: string[]): Promise<ExecutionPathScopeSnapshot> {
    if (!this.executionPathScope) throw new Error('O runtime de escopo de caminhos não foi configurado.');
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) throw new Error('O escopo precisa conter pelo menos um caminho permitido.');
    const canonical = await Promise.all(allowedPaths.map((value) => this.workspace.canonicalRelativePath(projectId, value)));
    return this.executionPathScope.configure({ chatId, runId, projectId, allowedPaths: canonical });
  }
  getChangeBudgetUsage(chatId: string, runId: string): ExecutionChangeUsage {
    return this.executionChangeBudget?.getUsage(chatId, runId) ?? { files: [], changedLines: 0, commands: 0, toolCalls: 0 };
  }
  getExecutionPlan(chatId: string, runId: string): ExecutionPlan | undefined { return this.executionPlanner?.get(chatId, runId); }
  async init(): Promise<void> {
    if (!this.journalStorage) return;
    const stored = await this.journalStorage.read<JournalEntry[]>(JOURNAL_FILE, []);
    this.journal.clear();
    if (!Array.isArray(stored)) return;
    for (const entry of stored) if (entry?.approvalId && entry.projectId && entry.toolCall?.id && entry.diffPlan?.changes?.length) this.journal.set(entry.approvalId, entry);
    await this.reconcileJournal();
  }
  listDefinitions(): AIToolDefinition[] { return definitions.map((definition) => ({ ...definition, parameters: { ...definition.parameters } })); }
  listApprovals(filters?: { chatId?: string; runId?: string }): ApprovalRequest[] { return this.approvals.list(filters); }
  restoreApprovals(approvals: ApprovalRequest[]): void { this.approvals.restore(approvals); }
  setApprovalChat(approvalId: string, chatId: string): ApprovalRequest { return this.approvals.setChatId(approvalId, chatId); }
  setApprovalRun(approvalId: string, runId: string): ApprovalRequest { return this.approvals.setRunId(approvalId, runId); }

  async execute(chatId: string, projectId: string, permission: PermissionLevel, call: AIToolCall, runId?: string): Promise<AIToolResult> {
    const normalizedCall = normalizeToolCall(call);
    const definition = definitions.find((item) => item.name === normalizedCall.name);
    if (!definition) return { toolCallId: normalizedCall.id, ok: false, error: `Ferramenta desconhecida: ${normalizedCall.name}` };
    try { validateToolInput(definition, normalizedCall.input); } catch (error) { return { toolCallId: normalizedCall.id, ok: false, error: error instanceof Error ? error.message : String(error) }; }

    let policy: ToolPolicyResult;
    try {
      policy = await this.evaluateToolPolicy(projectId, permission, normalizedCall, { chatId, runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { toolCallId: normalizedCall.id, ok: false, error: `Operação bloqueada pela política de segurança do workspace: ${message}.` };
    }
    const decision = policy.decision;
    const securityReasons = policy.reasons;
    if (decision === 'deny') return { toolCallId: normalizedCall.id, ok: false, error: this.policyDeniedMessage(policy) };

    const pending = this.approvals.list({ chatId, runId });
    if (pending.length) {
      const error = 'Operação adiada porque uma operação anterior deste ciclo ainda aguarda aprovação. Se ela continuar necessária após a decisão do usuário, solicite a operação novamente.';
      this.activity.emit({ type: 'action', message: `Adiado: ${normalizedCall.name}`, status: 'pending', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId });
      return { toolCallId: normalizedCall.id, ok: false, error };
    }
    if (decision === 'ask') {
      let diffPlan: DiffPlan | undefined;
      try { diffPlan = await this.preview(projectId, normalizedCall); } catch (error) {
        this.activity.emit({ type: 'action', message: `Pré-visualização indisponível para ${normalizedCall.name}: ${error instanceof Error ? error.message : String(error)}`, status: 'failed', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId });
        if (normalizedCall.name === 'write_file') {
          try {
            const path = this.stringValue(normalizedCall.input, 'path');
            const content = normalizedCall.input.content;
            if (typeof content === 'string' && !(await this.workspace.exists(projectId, path))) diffPlan = this.diffs.createPlan([this.diffs.create(path, 'created', '', content)]);
          } catch {}
        }
      }
      try {
        this.assertChangeBudget(chatId, runId, normalizedCall, diffPlan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.activity.emit({ type: 'action', message: `Bloqueado pelo Change Budget: ${normalizedCall.name}`, status: 'failed', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId, error: message, ...(diffPlan ? { diffPlan } : {}) });
        return { toolCallId: normalizedCall.id, ok: false, error: message, ...(diffPlan ? { diffPlan } : {}) };
      }
      const approval = this.approvals.request({ projectId, chatId, runId, permissionLevel: permission, toolCall: normalizedCall, ...(diffPlan ? { diffPlan } : {}) });
      const securityReason = (policy.sources.path === 'ask' || policy.sources.command === 'ask' || policy.sources.executionScope === 'ask') && securityReasons.length ? ` Segurança: ${securityReasons.join(' · ')}.` : '';
      this.activity.emit({ type: 'action', message: `Aguardando aprovação para ${normalizedCall.name}.${securityReason}`, status: 'pending', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId, ...(diffPlan ? { diffPlan } : {}) });
      return { toolCallId: normalizedCall.id, ok: false, error: 'Operação requer aprovação do usuário.', approvalId: approval.id, pendingApproval: true, ...(diffPlan ? { diffPlan } : {}) };
    }
    let directDiffPlan: DiffPlan | undefined;
    try {
      if (this.hasChangeBudget(chatId, runId) && this.isMutation(normalizedCall.name)) directDiffPlan = await this.preview(projectId, normalizedCall);
      this.assertChangeBudget(chatId, runId, normalizedCall, directDiffPlan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.emit({ type: 'action', message: `Bloqueado pelo Change Budget: ${normalizedCall.name}`, status: 'failed', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId, error: message, ...(directDiffPlan ? { diffPlan: directDiffPlan } : {}) });
      return { toolCallId: normalizedCall.id, ok: false, error: message, ...(directDiffPlan ? { diffPlan: directDiffPlan } : {}) };
    }
    return this.executeNow(projectId, normalizedCall, undefined, directDiffPlan, { chatId, runId });
  }

  async approve(approvalId: string): Promise<AIToolResult> {
    const approval = this.approvals.claim(approvalId);
    const journalResult = await this.getCompletedJournalResult(approval);
    if (journalResult) {
      this.approvals.resolve(approvalId);
      return journalResult;
    }
    try {
      const policy = await this.evaluateToolPolicy(approval.projectId, approval.permissionLevel, approval.toolCall, { chatId: approval.chatId, runId: approval.runId });
      if (policy.decision === 'deny') throw new Error(this.policyDeniedMessage(policy));
      await this.assertPrecondition(approval.projectId, approval.toolCall.name, approval.diffPlan);
      this.assertChangeBudget(approval.chatId, approval.runId, approval.toolCall, approval.diffPlan);
      const result = await this.executeNow(approval.projectId, approval.toolCall, approvalId, approval.diffPlan, { chatId: approval.chatId, runId: approval.runId });
      this.approvals.resolve(approvalId);
      return result;
    } catch (error) {
      this.approvals.release(approvalId);
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { toolCallId: approval.toolCall.id, ok: false, error: message, ...(approval.diffPlan ? { diffPlan: approval.diffPlan } : {}) };
    }
  }

  deny(approvalId: string): boolean {
    const approval = this.approvals.claim(approvalId);
    this.approvals.resolve(approval.id);
    this.activity.emit({ type: 'action', message: 'Operação recusada pelo usuário.', status: 'failed', toolCallId: approval.toolCall.id, toolName: approval.toolCall.name, chatId: approval.chatId, runId: approval.runId });
    return true;
  }

  private async evaluateToolPolicy(projectId: string, permissionLevel: PermissionLevel, call: AIToolCall, context: ActivityContext): Promise<ToolPolicyResult> {
    const rawPaths = extractToolPolicyPaths(call);
    const canonicalPaths = await Promise.all(rawPaths.map((value) => this.workspace.canonicalRelativePath(projectId, value)));
    return this.toolPolicy.evaluate({ permissionLevel, projectId, call, chatId: context.chatId, runId: context.runId, paths: canonicalPaths });
  }

  private policyDeniedMessage(policy: ToolPolicyResult): string {
    return policy.blockedBy === 'security'
      ? `Operação bloqueada pela política de segurança do workspace${policy.reasons.length ? `: ${policy.reasons.join(' · ')}` : ''}.`
      : 'Operação bloqueada pelas permissões do chat.';
  }

  private async preview(projectId: string, call: AIToolCall): Promise<DiffPlan | undefined> {
    switch (call.name) {
      case 'write_file': {
        const requestedPath = this.stringValue(call.input, 'path');
        const inspected = this.incrementalWorkspace
          ? await this.incrementalWorkspace.inspectWriteFile(projectId, requestedPath)
          : undefined;
        const path = inspected?.path ?? requestedPath;
        if (!inspected && !(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
        const before = inspected?.content ?? await this.workspace.readFile(projectId, path);
        const content = call.input.content;
        if (typeof content !== 'string') throw new Error("Parâmetro 'content' inválido.");
        return this.diffs.createPlan([this.diffs.create(path, 'modified', before, content)]);
      }
      case 'replace_range':
      case 'replace_text':
      case 'insert_before':
      case 'insert_after': {
        const requestedPath = this.stringValue(call.input, 'path');
        const inspected = this.incrementalWorkspace
          ? await this.incrementalWorkspace.inspectWriteFile(projectId, requestedPath)
          : undefined;
        const path = inspected?.path ?? requestedPath;
        if (!inspected && !(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe.');
        const before = inspected?.content ?? await this.workspace.readFile(projectId, path);
        const after = applyIncrementalEdit(call.name as IncrementalEditToolName, call.input, before);
        if (after === before) throw new Error('A edição incremental não produziria nenhuma alteração.');
        return this.diffs.createPlan([this.diffs.create(path, 'modified', before, after)]);
      }
      case 'replace_symbol': {
        const requestedPath = this.stringValue(call.input, 'path');
        const inspected = this.incrementalWorkspace
          ? await this.incrementalWorkspace.inspectWriteFile(projectId, requestedPath)
          : undefined;
        const path = inspected?.path ?? requestedPath;
        if (!inspected && !(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe.');
        const before = inspected?.content ?? await this.workspace.readFile(projectId, path);
        const symbol = this.stringValue(call.input, 'symbol');
        const kind = this.stringValue(call.input, 'kind') as StructuralSymbolKind;
        const content = call.input.content;
        if (typeof content !== 'string') throw new Error("Parâmetro 'content' inválido.");
        const result = await this.structuralEdits.replaceSymbol(path, before, { name: symbol, kind }, content);
        return this.diffs.createPlan([this.diffs.create(path, 'modified', before, result.after)]);
      }
      case 'create_file': {
        const requestedPath = this.stringValue(call.input, 'path');
        const path = this.incrementalWorkspace
          ? await this.incrementalWorkspace.inspectCreateFile(projectId, requestedPath)
          : requestedPath;
        if (!this.incrementalWorkspace && await this.workspace.exists(projectId, path)) throw new Error('O arquivo já existe. Use write_file para substituí-lo.');
        if (this.incrementalWorkspace && await this.workspace.exists(projectId, path)) {
          throw new Error(`O caminho '${path}' já existe em uma execução legada isolada. Conclua ou descarte essa execução antes de criar o arquivo incrementalmente.`);
        }
        const content = String(call.input.content ?? '');
        return this.diffs.createPlan([this.diffs.create(path, 'created', '', content)]);
      }
      case 'create_folder': {
        const requestedPath = this.stringValue(call.input, 'path');
        if (this.incrementalWorkspace) await this.incrementalWorkspace.inspectCreateFolder(projectId, requestedPath);
        return undefined;
      }
      case 'delete_file': {
        const requestedPath = this.stringValue(call.input, 'path');
        const inspected = this.incrementalWorkspace
          ? await this.incrementalWorkspace.inspectWriteFile(projectId, requestedPath)
          : undefined;
        const path = inspected?.path ?? requestedPath;
        const before = inspected?.content ?? await this.workspace.readFile(projectId, path);
        return this.diffs.createPlan([this.diffs.create(path, 'deleted', before, '')]);
      }
      case 'rename_file': {
        const requestedFrom = this.stringValue(call.input, 'from');
        const requestedTo = this.stringValue(call.input, 'to');
        if (this.incrementalWorkspace) {
          const inspected = await this.incrementalWorkspace.inspectRenameFile(projectId, requestedFrom, requestedTo);
          return this.diffs.createPlan([this.diffs.create(inspected.to, 'renamed', inspected.from.content, inspected.from.content, inspected.from.path)]);
        }
        const before = await this.workspace.readFile(projectId, requestedFrom);
        if (await this.workspace.exists(projectId, requestedTo)) throw new Error('O destino da renomeação já existe.');
        return this.diffs.createPlan([this.diffs.create(requestedTo, 'renamed', before, before, requestedFrom)]);
      }
      default: return undefined;
    }
  }

  private async assertPrecondition(projectId: string, toolName: ToolName, plan?: DiffPlan): Promise<void> {
    if (!plan) return;
    for (const change of plan.changes) {
      if (change.type === 'created') {
        if (this.incrementalWorkspace) {
          await this.incrementalWorkspace.inspectCreateFile(projectId, change.path).catch(() => {
            throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
          });
          if (await this.workspace.exists(projectId, change.path)) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
        } else if (await this.workspace.exists(projectId, change.path)) {
          throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
        }
        continue;
      }
      if (change.type === 'renamed') {
        const from = change.renamedFrom;
        if (!from) throw new Error(`A renomeação para '${change.path}' não possui origem válida.`);
        if (toolName === 'rename_file' && this.incrementalWorkspace) {
          const inspected = await this.incrementalWorkspace.inspectRenameFile(projectId, from, change.path).catch(() => {
            throw new Error(`A renomeação de '${from}' para '${change.path}' não corresponde mais ao estado aprovado.`);
          });
          if (inspected.from.content !== change.before) throw new Error(`O arquivo '${from}' mudou desde a aprovação.`);
          continue;
        }
        if (!(await this.workspace.exists(projectId, from)) || await this.workspace.exists(projectId, change.path)) throw new Error(`A renomeação de '${from}' para '${change.path}' não corresponde mais ao estado aprovado.`);
        const current = await this.workspace.readFile(projectId, from);
        if (current !== change.before) throw new Error(`O arquivo '${from}' mudou desde a aprovação.`);
        continue;
      }
      if (isRealWorkspaceTextMutation(toolName) && this.incrementalWorkspace) {
        const inspected = await this.incrementalWorkspace.inspectWriteFile(projectId, change.path).catch(() => {
          throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
        });
        if (inspected.content !== change.before) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
        continue;
      }
      if (!(await this.workspace.exists(projectId, change.path))) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
      const current = await this.workspace.readFile(projectId, change.path);
      if (current !== change.before) throw new Error(`O arquivo '${change.path}' mudou desde a aprovação.`);
    }
  }

  private stringValue(input: Record<string, unknown>, key: string): string { const value = input[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`Parâmetro '${key}' inválido.`); return value.trim(); }

  private hasChangeBudget(chatId?: string, runId?: string): boolean {
    return Boolean(this.executionChangeBudget && chatId && runId && this.executionChangeBudget.getBudget(chatId, runId));
  }

  private assertChangeBudget(chatId: string | undefined, runId: string | undefined, call: AIToolCall, diffPlan?: DiffPlan): void {
    if (!this.executionChangeBudget || !chatId || !runId) return;
    this.executionChangeBudget.assertAllowed(chatId, runId, { toolName: call.name, ...(diffPlan ? { diffPlan } : {}) });
  }

  private recordChangeBudget(context: ActivityContext, call: AIToolCall, execution: ToolExecution): void {
    if (!this.executionChangeBudget || !context.chatId || !context.runId) return;
    this.executionChangeBudget.record(context.chatId, context.runId, { toolName: call.name, ...(execution.changes ? { changes: execution.changes } : {}) });
  }

  private recordCheckpoint(projectId: string, context: ActivityContext, call: AIToolCall, execution: ToolExecution): void {
    if (!this.executionCheckpointRecorder || !context.chatId || !context.runId || !this.isMutation(call.name) || !execution.changes?.length) return;
    try {
      this.executionCheckpointRecorder({ chatId: context.chatId, runId: context.runId, projectId, toolCallId: call.id, changes: execution.changes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.emit({ type: 'action', message: `Checkpoint não registrado para ${call.name}: ${message}`, status: 'failed', toolCallId: call.id, toolName: call.name, ...context, error: message, changes: execution.changes });
    }
  }

  private async executeNow(projectId: string, call: AIToolCall, approvalId?: string, diffPlan?: DiffPlan, context: ActivityContext = {}): Promise<AIToolResult> {
    const activityType = call.name === 'run_command' || call.name === 'start_process' || call.name === 'stop_process' ? 'action' : 'tool';
    this.activity.emit({ type: activityType, message: executionActivityMessage(call), status: 'running', toolCallId: call.id, toolName: call.name, ...context });
    try {
      this.assertChangeBudget(context.chatId, context.runId, call, diffPlan);
      if (approvalId && diffPlan && this.isMutation(call.name)) await this.beginJournal(approvalId, projectId, call, diffPlan);
      const execution = await this.executeAllowed(projectId, call.name, call.input, { ...context, toolCallId: call.id });
      this.recordChangeBudget(context, call, execution);
      this.recordCheckpoint(projectId, context, call, execution);
      this.recordPlanEvidence(context, call, execution);
      const result: AIToolResult = { toolCallId: call.id, ok: true, output: execution.output, ...(execution.changes ? { changes: execution.changes } : {}), ...(execution.commandResult ? { commandResult: execution.commandResult } : {}) };
      this.activity.emit({ type: 'action', message: `Concluído: ${call.name}`, status: 'success', toolCallId: call.id, toolName: call.name, ...context, ...(execution.commandResult ? { commandResult: execution.commandResult } : {}), ...(execution.changes ? { changes: execution.changes } : {}), ...(diffPlan ? { diffPlan } : {}) });
      if (approvalId) await this.finishJournal(approvalId);
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.activity.emit({ type: activityType, message: `Falha em ${call.name}: ${message}`, status: 'failed', toolCallId: call.id, toolName: call.name, ...context, error: message, ...(diffPlan ? { diffPlan } : {}) });
      return { toolCallId: call.id, ok: false, error: message };
    }
  }

  private recordPlanEvidence(context: ActivityContext, call: AIToolCall, execution: ToolExecution): void {
    if (!this.executionPlanner || !context.chatId || !context.runId || call.name === 'plan_execution' || call.name === 'complete_plan_step') return;
    if (execution.commandResult && execution.commandResult.exitCode !== 0) return;
    const plan = this.executionPlanner.get(context.chatId, context.runId);
    if (!plan?.steps.some((step) => step.status === 'running')) return;
    let type: 'tool' | 'test' | 'build' | 'file' = execution.changes?.length ? 'file' : 'tool';
    let reference: string | undefined;
    if (execution.commandResult) {
      const command = execution.commandResult.command;
      reference = command;
      if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/i.test(command)) type = 'test';
      else if (/\b(build|compile|tsc)\b/i.test(command)) type = 'build';
    } else if (execution.changes?.length) {
      reference = execution.changes.map((change) => change.path).join(', ');
    } else if (typeof call.input.path === 'string') reference = call.input.path;
    else if (typeof call.input.symbol === 'string') reference = call.input.symbol;
    try {
      this.executionPlanner.recordEvidence(context.chatId, context.runId, { type, summary: `${call.name} concluído`, ...(reference ? { reference } : {}) });
    } catch {}
  }

  private isMutation(name: ToolName): boolean { return name === 'write_file' || name === 'create_file' || name === 'create_folder' || name === 'replace_range' || name === 'replace_text' || name === 'replace_symbol' || name === 'insert_before' || name === 'insert_after' || name === 'delete_file' || name === 'rename_file'; }
  private async beginJournal(approvalId: string, projectId: string, toolCall: AIToolCall, diffPlan: DiffPlan): Promise<void> { if (!this.journalStorage) return; if (!this.journal.has(approvalId)) { this.journal.set(approvalId, { approvalId, projectId, toolCall, diffPlan, status: 'executing' }); await this.persistJournal(); } }
  private async finishJournal(approvalId: string): Promise<void> { if (!this.journalStorage) return; this.journal.delete(approvalId); await this.persistJournal(); }
  private async getCompletedJournalResult(approval: ApprovalRequest): Promise<AIToolResult | undefined> {
    const entry = this.journal.get(approval.id);
    if (!entry) return undefined;
    if (!(await this.matchesExpectedState(entry))) return undefined;
    const result = await this.buildJournalResult(entry);
    if (result.changes?.length && approval.chatId && approval.runId) this.recordCheckpoint(approval.projectId, { chatId: approval.chatId, runId: approval.runId }, approval.toolCall, { output: result.output ?? '', changes: result.changes });
    await this.finishJournal(approval.id);
    return result;
  }
  private async buildJournalResult(entry: JournalEntry): Promise<AIToolResult> { const changes: FileDiff[] = []; for (const change of entry.diffPlan.changes) { if (change.type === 'deleted') changes.push(this.diffs.create(change.path, 'deleted', change.before, '')); else if (change.type === 'renamed') changes.push(this.diffs.create(change.path, 'renamed', change.before, change.after, change.renamedFrom)); else changes.push(this.diffs.create(change.path, change.type, change.before, change.after)); } return { toolCallId: entry.toolCall.id, ok: true, output: 'Operação recuperada após uma interrupção.', changes, diffPlan: entry.diffPlan }; }
  private async matchesExpectedState(entry: JournalEntry): Promise<boolean> { for (const change of entry.diffPlan.changes) { if (change.type === 'deleted') { if (await this.workspace.exists(entry.projectId, change.path)) return false; continue; } if (change.type === 'renamed') { const from = change.renamedFrom; if (!from || await this.workspace.exists(entry.projectId, from) || !(await this.workspace.exists(entry.projectId, change.path))) return false; if (await this.workspace.readFile(entry.projectId, change.path) !== change.after) return false; continue; } if (!(await this.workspace.exists(entry.projectId, change.path))) return false; if (await this.workspace.readFile(entry.projectId, change.path) !== change.after) return false; } return true; }
  private async reconcileJournal(): Promise<void> { for (const [approvalId, entry] of this.journal) if (await this.matchesExpectedState(entry)) this.activity.emit({ type: 'action', message: `Operação ${approvalId} concluída durante uma interrupção anterior.`, status: 'success', toolCallId: entry.toolCall.id, toolName: entry.toolCall.name }); await this.persistJournal(); }
  private async persistJournal(): Promise<void> { if (!this.journalStorage) return; const snapshot = [...this.journal.values()]; const write = this.journalWrite.then(() => this.journalStorage!.write(JOURNAL_FILE, snapshot)); this.journalWrite = write.catch(() => {}); await write; }

  private async visibleSearchPaths(projectId: string, paths: string[], context: ActivityContext): Promise<string[]> {
    if (!this.executionPathScope || !context.chatId || !context.runId || !this.executionPathScope.get(context.chatId, context.runId)) return paths;
    const visible = new Set<string>();
    for (const value of paths) {
      try {
        const canonical = await this.workspace.canonicalRelativePath(projectId, value);
        if (this.executionPathScope.allowsPath(context.chatId, context.runId, projectId, canonical)) visible.add(canonical);
      } catch {
      }
    }
    return [...visible].sort();
  }

  private async executeAllowed(projectId: string, name: ToolName, input: Record<string, unknown>, context: ActivityContext = {}): Promise<ToolExecution> {
    switch (name) {
      case 'plan_execution': {
        if (!this.executionPlanner) throw new Error('O planner de execução não foi configurado.');
        if (!context.chatId || !context.runId) throw new Error('Contexto da execução indisponível para o planner.');
        const objective = this.stringValue(input, 'objective');
        const steps = input.steps;
        if (!Array.isArray(steps) || steps.length === 0 || steps.some((step) => typeof step !== 'string' || !step.trim())) throw new Error("Parâmetro 'steps' inválido.");
        const created = this.executionPlanner.create(context.chatId, context.runId, objective, steps.map((step) => String(step).trim()));
        const started = this.executionPlanner.startStep(context.chatId, context.runId, created.steps[0].id);
        return { output: JSON.stringify(started) };
      }
      case 'complete_plan_step': {
        if (!this.executionPlanner) throw new Error('O planner de execução não foi configurado.');
        if (!context.chatId || !context.runId) throw new Error('Contexto da execução indisponível para o planner.');
        const current = this.executionPlanner.get(context.chatId, context.runId);
        if (!current) throw new Error('Plano da execução não encontrado.');
        const running = current.steps.find((step) => step.status === 'running');
        if (!running) throw new Error('Nenhum passo do plano está em execução.');
        if (!running.evidence.length) throw new Error('O passo atual ainda não possui evidência real de execução.');
        let updated = this.executionPlanner.completeStep(context.chatId, context.runId, running.id);
        if (updated.status !== 'completed' && updated.status !== 'failed') {
          const next = updated.steps.find((step) => step.status === 'pending');
          if (next) updated = this.executionPlanner.startStep(context.chatId, context.runId, next.id);
        }
        return { output: JSON.stringify(updated) };
      }
      case 'read_file': return { output: await this.workspace.readFile(projectId, this.stringValue(input, 'path')) };
      case 'read_symbol': { const path = this.stringValue(input, 'path'); if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe.'); const source = await this.workspace.readFile(projectId, path); const symbol = this.stringValue(input, 'symbol'); const kind = this.stringValue(input, 'kind') as StructuralSymbolKind; const result = await this.structuralEdits.readSymbol(path, source, { name: symbol, kind }); return { output: result.content }; }
      case 'write_file': {
        const path = this.stringValue(input, 'path');
        const content = input.content;
        if (typeof content !== 'string') throw new Error("Parâmetro 'content' inválido.");
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const result = await this.incrementalWorkspace.writeFile({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, path, content);
          return {
            output: JSON.stringify({ type: 'workspace_file_updated', path: result.path, operationId: result.operationId, beforeHash: result.beforeHash, afterHash: result.afterHash, bytes: result.bytes, rollbackRef: result.rollbackRef }),
            changes: [this.diffs.create(result.path, 'modified', result.before, result.after)],
          };
        }
        if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
        const before = await this.workspace.readFile(projectId, path);
        await this.workspace.writeFile(projectId, path, content);
        const after = await this.workspace.readFile(projectId, path);
        return { output: 'Arquivo atualizado.', changes: [this.diffs.create(path, 'modified', before, after)] };
      }
      case 'replace_range':
      case 'replace_text':
      case 'insert_before':
      case 'insert_after': {
        const path = this.stringValue(input, 'path');
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const inspected = await this.incrementalWorkspace.inspectWriteFile(projectId, path);
          const after = applyIncrementalEdit(name as IncrementalEditToolName, input, inspected.content);
          if (after === inspected.content) throw new Error('A edição incremental não produziria nenhuma alteração.');
          const result = await this.incrementalWorkspace.writeFile({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, inspected.path, after, inspected.content);
          return {
            output: JSON.stringify({ type: 'workspace_file_incrementally_updated', tool: name, path: result.path, operationId: result.operationId, beforeHash: result.beforeHash, afterHash: result.afterHash, bytes: result.bytes, rollbackRef: result.rollbackRef }),
            changes: [this.diffs.create(result.path, 'modified', result.before, result.after)],
          };
        }
        if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe.');
        const before = await this.workspace.readFile(projectId, path);
        const after = applyIncrementalEdit(name as IncrementalEditToolName, input, before);
        if (after === before) throw new Error('A edição incremental não produziria nenhuma alteração.');
        await this.workspace.writeFile(projectId, path, after);
        const persisted = await this.workspace.readFile(projectId, path);
        return { output: 'Trecho do arquivo atualizado.', changes: [this.diffs.create(path, 'modified', before, persisted)] };
      }
      case 'replace_symbol': {
        const path = this.stringValue(input, 'path');
        const symbol = this.stringValue(input, 'symbol');
        const kind = this.stringValue(input, 'kind') as StructuralSymbolKind;
        const content = input.content;
        if (typeof content !== 'string') throw new Error("Parâmetro 'content' inválido.");
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const inspected = await this.incrementalWorkspace.inspectWriteFile(projectId, path);
          const structural = await this.structuralEdits.replaceSymbol(inspected.path, inspected.content, { name: symbol, kind }, content);
          const result = await this.incrementalWorkspace.writeFile({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, inspected.path, structural.after, inspected.content);
          return {
            output: JSON.stringify({ type: 'workspace_symbol_updated', symbol, kind, path: result.path, operationId: result.operationId, beforeHash: result.beforeHash, afterHash: result.afterHash, bytes: result.bytes, rollbackRef: result.rollbackRef }),
            changes: [this.diffs.create(result.path, 'modified', result.before, result.after)],
          };
        }
        if (!(await this.workspace.exists(projectId, path))) throw new Error('O arquivo não existe.');
        const before = await this.workspace.readFile(projectId, path);
        const structural = await this.structuralEdits.replaceSymbol(path, before, { name: symbol, kind }, content);
        await this.workspace.writeFile(projectId, path, structural.after);
        const persisted = await this.workspace.readFile(projectId, path);
        return { output: 'Símbolo atualizado.', changes: [this.diffs.create(path, 'modified', before, persisted)] };
      }
      case 'create_file': {
        const path = this.stringValue(input, 'path');
        const content = String(input.content ?? '');
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const result = await this.incrementalWorkspace.createFile({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, path, content);
          return {
            output: JSON.stringify({ type: 'workspace_file_created', path: result.path, operationId: result.operationId, hash: result.hash, bytes: result.bytes, createdDirectories: result.createdDirectories }),
            changes: [this.diffs.create(result.path, 'created', '', content)],
          };
        }
        await this.workspace.createFile(projectId, path, content);
        const after = await this.workspace.readFile(projectId, path);
        return { output: 'Arquivo criado.', changes: [this.diffs.create(path, 'created', '', after)] };
      }
      case 'create_folder': {
        const path = this.stringValue(input, 'path');
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const result = await this.incrementalWorkspace.createFolder({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, path);
          return { output: JSON.stringify({ type: 'workspace_folder_created', ...result }) };
        }
        const created = await this.workspace.createFolder(projectId, path);
        return { output: JSON.stringify({ type: 'workspace_folder_created', path, created, createdDirectories: created ? [path] : [] }) };
      }
      case 'delete_file': {
        const path = this.stringValue(input, 'path');
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const inspected = await this.incrementalWorkspace.inspectWriteFile(projectId, path);
          const result = await this.incrementalWorkspace.deleteFile({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, inspected.path, inspected.content);
          return {
            output: JSON.stringify({ type: 'workspace_file_deleted', path: result.path, operationId: result.operationId, beforeHash: result.beforeHash, rollbackRef: result.rollbackRef }),
            changes: [this.diffs.create(result.path, 'deleted', result.before, '')],
          };
        }
        const before = await this.workspace.readFile(projectId, path);
        await this.workspace.deleteFile(projectId, path);
        return { output: 'Arquivo excluído.', changes: [this.diffs.create(path, 'deleted', before, '')] };
      }
      case 'rename_file': {
        const from = this.stringValue(input, 'from');
        const to = this.stringValue(input, 'to');
        if (this.incrementalWorkspace && context.runId && context.toolCallId) {
          const inspected = await this.incrementalWorkspace.inspectRenameFile(projectId, from, to);
          const result = await this.incrementalWorkspace.renameFile({
            runId: context.runId,
            toolCallId: context.toolCallId,
            projectId,
          }, inspected.from.path, inspected.to, inspected.from.content);
          return {
            output: JSON.stringify({ type: 'workspace_file_renamed', from: result.from, to: result.to, operationId: result.operationId, hash: result.hash, rollbackRef: result.rollbackRef, createdDirectories: result.createdDirectories }),
            changes: [this.diffs.create(result.to, 'renamed', result.content, result.content, result.from)],
          };
        }
        const before = await this.workspace.readFile(projectId, from);
        await this.workspace.renameFile(projectId, from, to);
        const after = await this.workspace.readFile(projectId, to);
        return { output: 'Arquivo renomeado.', changes: [this.diffs.create(to, 'renamed', before, after, from)] };
      }
      case 'search_files': { const matches = await this.workspace.searchFiles(projectId, this.stringValue(input, 'query')); return { output: JSON.stringify(await this.visibleSearchPaths(projectId, matches, context)) }; }
      case 'start_process': {
        const runtime = this.requireProcessRuntime();
        const started = await runtime.start(projectId, this.stringValue(input, 'command'));
        return { output: JSON.stringify({ type: 'process_started', processId: started.id, pid: started.pid, command: started.command, status: started.status, startedAt: started.startedAt }) };
      }
      case 'read_process_output': {
        const runtime = this.requireProcessRuntime();
        const processId = this.stringValue(input, 'processId');
        this.assertProcessProject(runtime, processId, projectId);
        const afterSequence = Number(input.afterSequence);
        if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("Parâmetro 'afterSequence' deve ser um inteiro >= 0.");
        return { output: JSON.stringify(runtime.readOutput(processId, afterSequence)) };
      }
      case 'wait_process': {
        const runtime = this.requireProcessRuntime();
        const processId = this.stringValue(input, 'processId');
        this.assertProcessProject(runtime, processId, projectId);
        const timeoutMs = Number(input.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Parâmetro 'timeoutMs' deve ser um número >= 0.");
        return { output: JSON.stringify(await runtime.wait(processId, timeoutMs)) };
      }
      case 'stop_process': {
        const runtime = this.requireProcessRuntime();
        const processId = this.stringValue(input, 'processId');
        this.assertProcessProject(runtime, processId, projectId);
        return { output: JSON.stringify(await runtime.stop(processId)) };
      }
      case 'list_processes': {
        const runtime = this.requireProcessRuntime();
        return { output: JSON.stringify(runtime.list(projectId)) };
      }
      case 'run_command': { const result = await this.commands.run(projectId, this.stringValue(input, 'command')); return { output: result.stdout || result.stderr || 'Comando concluído sem saída.', commandResult: result }; }
      case 'git_status': return this.gitExecution(projectId, await this.requireGit().status(projectId));
      case 'git_diff': return this.gitExecution(projectId, await this.requireGit().diff(projectId));
      case 'git_log': return this.gitExecution(projectId, await this.requireGit().log(projectId, Number(input.limit)));
      case 'git_branches': return this.gitExecution(projectId, await this.requireGit().branches(projectId));
      case 'git_create_branch': return this.gitExecution(projectId, await this.requireGit().createBranch(projectId, this.stringValue(input, 'name')));
      case 'git_checkout': return this.gitExecution(projectId, await this.requireGit().checkout(projectId, this.stringValue(input, 'name')));
      case 'git_stage': { const paths = input.paths; if (!Array.isArray(paths) || paths.length === 0 || paths.some((item) => typeof item !== 'string' || !item.trim())) throw new Error("Parâmetro 'paths' inválido."); return this.gitExecution(projectId, await this.requireGit().stage(projectId, paths)); }
      case 'git_stage_all': return this.gitExecution(projectId, await this.requireGit().stageAll(projectId));
      case 'git_commit': return this.gitExecution(projectId, await this.requireGit().commit(projectId, this.stringValue(input, 'message')));
    }
  }
  private requireProcessRuntime(): ProcessRuntime { if (!this.processRuntime) throw new Error('O runtime de processos persistentes não foi configurado para esta instância.'); return this.processRuntime; }
  private assertProcessProject(runtime: ProcessRuntime, processId: string, projectId: string): void {
    const process = runtime.get(processId);
    if (process.projectId !== projectId) throw new Error('O processo persistente pertence a outro projeto.');
  }
  private requireGit(): GitRuntime { if (!this.gitRuntime) throw new Error('O runtime Git não foi configurado para esta instância.'); return this.gitRuntime; }
  private gitExecution(_projectId: string, value: unknown): ToolExecution { return { output: typeof value === 'string' ? value : JSON.stringify(value) }; }
}
