import type { AIToolCall, PermissionLevel } from '../ai/types';
import type { ExecutionPathScopeRuntime } from '../execution-path-scope';
import { SYSTEM_WORKSPACE_ID } from './system-workspace';
import { CommandSafetyPolicy } from './command-safety-policy';
import { PermissionRuntime, type PermissionDecision } from './permission-runtime';
import { WorkspacePathPolicy, type WorkspacePathClassification } from './workspace-path-policy';

export type ToolPolicyDecisionSource = {
  permission: PermissionDecision;
  path: PermissionDecision;
  command: PermissionDecision;
  systemWorkspace: PermissionDecision;
  executionScope: PermissionDecision;
};

export type ToolPolicyResult = {
  decision: PermissionDecision;
  blockedBy: 'permission' | 'security' | null;
  classification: WorkspacePathClassification;
  paths: string[];
  reasons: string[];
  sources: ToolPolicyDecisionSource;
};

const systemFileTools = new Set<AIToolCall['name']>([
  'read_file',
  'write_file',
  'create_file',
  'replace_range',
  'replace_text',
  'replace_symbol',
  'insert_before',
  'insert_after',
  'delete_file',
  'rename_file',
  'search_files',
]);

export function extractToolPolicyPaths(call: AIToolCall): string[] {
  if (call.name === 'rename_file') {
    const from = typeof call.input.from === 'string' ? call.input.from : '';
    const to = typeof call.input.to === 'string' ? call.input.to : '';
    return [from, to].filter(Boolean);
  }
  if (call.name === 'git_stage') {
    return Array.isArray(call.input.paths)
      ? call.input.paths.filter((item): item is string => typeof item === 'string')
      : [];
  }
  if (
    call.name === 'read_file'
    || call.name === 'read_symbol'
    || call.name === 'write_file'
    || call.name === 'create_file'
    || call.name === 'replace_range'
    || call.name === 'replace_text'
    || call.name === 'replace_symbol'
    || call.name === 'insert_before'
    || call.name === 'insert_after'
    || call.name === 'delete_file'
  ) {
    return typeof call.input.path === 'string' ? [call.input.path] : [];
  }
  return [];
}

function severity(decision: PermissionDecision): number {
  if (decision === 'deny') return 2;
  if (decision === 'ask') return 1;
  return 0;
}

function stronger(left: PermissionDecision, right: PermissionDecision): PermissionDecision {
  return severity(left) >= severity(right) ? left : right;
}

export class ToolPolicyRuntime {
  private executionScopes?: ExecutionPathScopeRuntime;

  constructor(
    private readonly permissions = new PermissionRuntime(),
    private readonly workspacePaths = new WorkspacePathPolicy(),
    private readonly commands = new CommandSafetyPolicy(workspacePaths),
  ) {}

  configureExecutionPathScope(runtime: ExecutionPathScopeRuntime): void {
    this.executionScopes = runtime;
  }

  evaluate(input: {
    permissionLevel: PermissionLevel;
    projectId: string;
    call: AIToolCall;
    chatId?: string;
    runId?: string;
    paths?: string[];
  }): ToolPolicyResult {
    const paths = input.paths ?? extractToolPolicyPaths(input.call);
    const permissionDecision = this.permissions.decide(input.permissionLevel, input.call.name);
    const pathPolicy = this.workspacePaths.evaluate(input.call.name, paths);
    const commandPolicy = input.call.name === 'run_command'
      ? this.commands.evaluate(typeof input.call.input.command === 'string' ? input.call.input.command : '')
      : { decision: 'allow' as const, reasons: [] as string[], matchedPaths: [] as string[] };
    const systemWorkspaceDecision: PermissionDecision = input.projectId === SYSTEM_WORKSPACE_ID
      && input.permissionLevel !== 'unrestricted'
      && systemFileTools.has(input.call.name)
      ? 'ask'
      : 'allow';
    const executionScopePolicy = this.executionScopes?.evaluate({
      chatId: input.chatId,
      runId: input.runId,
      projectId: input.projectId,
      toolName: input.call.name,
      paths,
    }) ?? { configured: false, decision: 'allow' as const, reasons: [], allowedPaths: [], requestedPaths: [] };

    let decision = stronger(permissionDecision, pathPolicy.decision);
    decision = stronger(decision, commandPolicy.decision);
    decision = stronger(decision, systemWorkspaceDecision);
    decision = stronger(decision, executionScopePolicy.decision);

    const reasons = [...new Set([
      ...pathPolicy.reasons,
      ...commandPolicy.reasons,
      ...(systemWorkspaceDecision === 'ask' ? ['workspace interno do Auto CodeZ'] : []),
      ...executionScopePolicy.reasons,
    ])];
    const securityDenied = pathPolicy.decision === 'deny'
      || commandPolicy.decision === 'deny'
      || executionScopePolicy.decision === 'deny';

    return {
      decision,
      blockedBy: decision !== 'deny' ? null : securityDenied ? 'security' : 'permission',
      classification: pathPolicy.classification,
      paths,
      reasons,
      sources: {
        permission: permissionDecision,
        path: pathPolicy.decision,
        command: commandPolicy.decision,
        systemWorkspace: systemWorkspaceDecision,
        executionScope: executionScopePolicy.decision,
      },
    };
  }
}
