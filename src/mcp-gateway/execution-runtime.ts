import crypto from 'node:crypto';
import type { AIToolResult, PermissionLevel, ToolName } from '../ai/types';
import type { AgentRuntime } from '../agent/agent-runtime';
import { SYSTEM_PROJECT_ID } from '../agent/command-runtime';
import type { PluginToolCatalog, PluginToolDescriptor } from '../plugins/plugin-tool-catalog';
import type { OperationalLedger } from '../operational-ledger';

export type McpGatewayOperationState = 'running' | 'waiting_approval' | 'success' | 'failed' | 'denied';

export type McpGatewayOperation = {
  operationId: string;
  externalToolName: string;
  pluginId: string;
  pluginToolId: string;
  chatId: string;
  runId: string;
  projectId: string;
  permission: PermissionLevel;
  state: McpGatewayOperationState;
  approvalId?: string;
  result?: AIToolResult;
  createdAt: number;
  updatedAt: number;
};

export type McpGatewayPluginTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  pluginId: string;
  pluginToolId: string;
  risk: PluginToolDescriptor['risk'];
};

const MAX_OPERATIONS = 256;
const OPERATION_TTL_MS = 60 * 60 * 1000;

function sanitizeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'plugin';
}

function stableExternalName(descriptor: PluginToolDescriptor): string {
  if (descriptor.pluginId === 'autocodez.roblox-studio-manager') {
    return `roblox_${sanitizeName(descriptor.toolId)}`;
  }
  const digest = crypto.createHash('sha256').update(descriptor.pluginId).digest('hex').slice(0, 8);
  const plugin = sanitizeName(descriptor.pluginId).slice(0, 20);
  const tool = sanitizeName(descriptor.toolId).slice(0, 32);
  return `plugin_${plugin}_${digest}_${tool}`.slice(0, 96);
}

function cloneResult(result: AIToolResult | undefined): AIToolResult | undefined {
  return result ? structuredClone(result) : undefined;
}

function normalizeClientId(value: string | undefined): string {
  const normalized = (value ?? 'mcp-external').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return normalized || 'mcp-external';
}

function cloneOperation(operation: McpGatewayOperation): McpGatewayOperation {
  return { ...operation, result: cloneResult(operation.result) };
}

export class McpGatewayExecutionRuntime {
  private readonly operations = new Map<string, McpGatewayOperation>();
  private readonly approvals = new Map<string, string>();

  constructor(
    private readonly agentRuntime: AgentRuntime,
    private readonly pluginCatalog: PluginToolCatalog,
    private readonly ledger?: OperationalLedger,
  ) {}

  listTools(): McpGatewayPluginTool[] {
    const used = new Set<string>();
    return this.pluginCatalog.list().map((descriptor) => {
      let name = stableExternalName(descriptor);
      if (used.has(name)) {
        const suffix = crypto.createHash('sha256').update(descriptor.name).digest('hex').slice(0, 8);
        name = `${name.slice(0, 87)}_${suffix}`;
      }
      used.add(name);
      return {
        name,
        description: descriptor.description,
        inputSchema: structuredClone(descriptor.parameters),
        pluginId: descriptor.pluginId,
        pluginToolId: descriptor.toolId,
        risk: descriptor.risk,
      };
    });
  }

  getOperation(operationId: string): McpGatewayOperation | undefined {
    this.prune();
    const operation = this.operations.get(operationId);
    return operation ? cloneOperation(operation) : undefined;
  }

  ownsApproval(approvalId: string): boolean {
    this.prune();
    return this.approvals.has(approvalId);
  }

  operationForApproval(approvalId: string): McpGatewayOperation | undefined {
    const operationId = this.approvals.get(approvalId);
    return operationId ? this.getOperation(operationId) : undefined;
  }

  async execute(
    externalToolName: string,
    input: Record<string, unknown>,
    options: {
      clientId?: string;
      permission?: PermissionLevel;
      projectId?: string;
    } = {},
  ): Promise<McpGatewayOperation> {
    this.prune();
    const tool = this.listTools().find((item) => item.name === externalToolName);
    if (!tool) throw new Error(`MCP Gateway plugin tool not found: ${externalToolName}.`);
    const descriptor = this.pluginCatalog.list().find((item) => item.pluginId === tool.pluginId && item.toolId === tool.pluginToolId);
    if (!descriptor) throw new Error('Plugin tool disappeared before execution.');

    const operationId = crypto.randomUUID();
    const clientId = normalizeClientId(options.clientId);
    const chatId = `mcp:${clientId}`;
    const runId = `mcp:${operationId}`;
    const projectId = options.projectId?.trim() || SYSTEM_PROJECT_ID;
    const permission = options.permission ?? 'ask';
    const now = Date.now();

    const operation: McpGatewayOperation = {
      operationId,
      externalToolName,
      pluginId: descriptor.pluginId,
      pluginToolId: descriptor.toolId,
      chatId,
      runId,
      projectId,
      permission,
      state: 'running',
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(operationId, operation);
    this.ledger?.record({
      actor: 'external',
      category: 'execution',
      state: 'running',
      summary: `Cliente MCP iniciou ${externalToolName}.`,
      chatId,
      runId,
      projectId,
      clientId,
      pluginId: descriptor.pluginId,
      toolName: externalToolName,
      causationId: operationId,
      details: { permission },
    });

    const call = {
      id: `mcp_gateway_${operationId}`,
      name: 'plugin_call' as ToolName,
      input: {
        tool: descriptor.name,
        arguments: JSON.stringify(input ?? {}),
      },
    };

    const result = await this.agentRuntime.executeExternalTool({
      chatId,
      projectId,
      runId,
      permission,
      call,
    });

    operation.result = structuredClone(result);
    operation.updatedAt = Date.now();
    if (result.pendingApproval && result.approvalId) {
      operation.state = 'waiting_approval';
      operation.approvalId = result.approvalId;
      this.approvals.set(result.approvalId, operationId);
    } else {
      operation.state = result.ok ? 'success' : 'failed';
    }

    this.ledger?.record({
      actor: 'external',
      category: 'execution',
      state: operation.state === 'waiting_approval' ? 'waiting' : operation.state === 'success' ? 'success' : 'failed',
      summary: operation.state === 'waiting_approval'
        ? `Cliente MCP aguarda aprovação para ${externalToolName}.`
        : operation.state === 'success'
          ? `Cliente MCP concluiu ${externalToolName}.`
          : `Cliente MCP falhou em ${externalToolName}.`,
      chatId,
      runId,
      projectId,
      clientId,
      pluginId: descriptor.pluginId,
      toolName: externalToolName,
      causationId: operationId,
      ...(result.error ? { error: result.error } : {}),
      ...(result.approvalId ? { details: { approvalId: result.approvalId } } : {}),
    });

    this.prune();
    return cloneOperation(operation);
  }

  async approve(approvalId: string): Promise<McpGatewayOperation> {
    this.prune();
    const operationId = this.approvals.get(approvalId);
    if (!operationId) throw new Error('MCP Gateway approval not found.');
    const operation = this.operations.get(operationId);
    if (!operation || operation.approvalId !== approvalId || operation.state !== 'waiting_approval') throw new Error('MCP Gateway approval is stale.');

    const result = await this.agentRuntime.approveExternalTool(approvalId);
    operation.result = structuredClone(result);
    operation.updatedAt = Date.now();
    if (result.pendingApproval && result.approvalId) {
      this.approvals.delete(approvalId);
      operation.approvalId = result.approvalId;
      operation.state = 'waiting_approval';
      this.approvals.set(result.approvalId, operationId);
    } else {
      this.approvals.delete(approvalId);
      operation.approvalId = undefined;
      operation.state = result.ok ? 'success' : 'failed';
    }
    this.ledger?.record({
      actor: 'external',
      category: 'execution',
      state: operation.state === 'success' ? 'success' : operation.state === 'waiting_approval' ? 'waiting' : 'failed',
      summary: operation.state === 'success' ? `Operação MCP aprovada e concluída: ${operation.externalToolName}.` : `Operação MCP atualizada após aprovação: ${operation.externalToolName}.`,
      chatId: operation.chatId,
      runId: operation.runId,
      projectId: operation.projectId,
      clientId: operation.chatId.slice('mcp:'.length),
      pluginId: operation.pluginId,
      toolName: operation.externalToolName,
      causationId: operation.operationId,
      ...(result.error ? { error: result.error } : {}),
    });
    return cloneOperation(operation);
  }

  deny(approvalId: string): McpGatewayOperation {
    this.prune();
    const operationId = this.approvals.get(approvalId);
    if (!operationId) throw new Error('MCP Gateway approval not found.');
    const operation = this.operations.get(operationId);
    if (!operation || operation.approvalId !== approvalId || operation.state !== 'waiting_approval') throw new Error('MCP Gateway approval is stale.');

    this.agentRuntime.denyExternalTool(approvalId);
    this.approvals.delete(approvalId);
    operation.approvalId = undefined;
    operation.state = 'denied';
    operation.updatedAt = Date.now();
    operation.result = {
      toolCallId: `mcp_gateway_${operationId}`,
      ok: false,
      error: 'Operation denied by the user in Auto CodeZ.',
    };
    this.ledger?.record({
      actor: 'external',
      category: 'execution',
      state: 'failed',
      summary: `Operação MCP recusada: ${operation.externalToolName}.`,
      chatId: operation.chatId,
      runId: operation.runId,
      projectId: operation.projectId,
      clientId: operation.chatId.slice('mcp:'.length),
      pluginId: operation.pluginId,
      toolName: operation.externalToolName,
      causationId: operation.operationId,
      error: 'Operation denied by the user in Auto CodeZ.',
    });
    return cloneOperation(operation);
  }

  private prune(): void {
    const cutoff = Date.now() - OPERATION_TTL_MS;
    for (const [operationId, operation] of this.operations) {
      if (operation.updatedAt >= cutoff || operation.state === 'waiting_approval' || operation.state === 'running') continue;
      this.operations.delete(operationId);
      if (operation.approvalId) this.approvals.delete(operation.approvalId);
    }
    if (this.operations.size <= MAX_OPERATIONS) return;
    const removable = [...this.operations.values()]
      .filter((operation) => operation.state !== 'waiting_approval' && operation.state !== 'running')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.operations.size > MAX_OPERATIONS && removable.length) {
      const operation = removable.shift();
      if (!operation) break;
      this.operations.delete(operation.operationId);
      if (operation.approvalId) this.approvals.delete(operation.approvalId);
    }
  }
}
