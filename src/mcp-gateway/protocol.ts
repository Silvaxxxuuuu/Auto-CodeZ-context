import type { OperationalLedgerPage } from '../operational-ledger';
import type { OperationalLedgerRetrieval, OperationalLedgerScope, OperationalSessionSummary } from '../operational-ledger-retrieval';

export const MCP_GATEWAY_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_TEXT_RESULT = 16 * 1024;

export type McpGatewayTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

export type McpJsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type McpJsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpGatewayClientContext = {
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
};

type SessionQuery = {
  scope: OperationalLedgerScope;
  limit?: number;
  beforeSequence?: number;
};

const SCOPE_PROPERTIES = {
  chatId: { type: 'string', maxLength: 160 },
  runId: { type: 'string', maxLength: 160 },
  projectId: { type: 'string', maxLength: 160 },
  sessionId: { type: 'string', maxLength: 160 },
  pluginId: { type: 'string', maxLength: 160 },
} as const;

const SESSION_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      type: 'object',
      properties: SCOPE_PROPERTIES,
      additionalProperties: false,
    },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    beforeSequence: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
} as const;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      type: 'object',
      properties: SCOPE_PROPERTIES,
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const tools: McpGatewayTool[] = [
  {
    name: 'session_summary',
    description: 'Return a bounded operational summary for an Auto CodeZ session, run, chat, project, or plugin scope.',
    inputSchema: SUMMARY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'session_recent_events',
    description: 'Return recent authoritative Auto CodeZ operational events for a bounded scope.',
    inputSchema: SESSION_QUERY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'session_changes',
    description: 'Return recent events that touched resources or produced diff metadata.',
    inputSchema: SESSION_QUERY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'session_errors',
    description: 'Return recent failed operational events and sanitized errors.',
    inputSchema: SESSION_QUERY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'session_artifacts',
    description: 'Return recent events that reference artifacts produced by Auto CodeZ.',
    inputSchema: SESSION_QUERY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'session_sources',
    description: 'Return recent events containing external source provenance.',
    inputSchema: SESSION_QUERY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function boundedTextResult(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_TEXT_RESULT) return serialized;
  return JSON.stringify({ truncated: true, message: 'Structured result is available in structuredContent; text mirror was truncated.' });
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: boundedTextResult(value) }],
    structuredContent: value,
    isError: false,
  };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function scopeFrom(value: unknown): OperationalLedgerScope {
  const input = asRecord(value, 'scope');
  const allowed = new Set(Object.keys(SCOPE_PROPERTIES));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown scope field: ${key}.`);
  return {
    ...(optionalIdentifier(input.chatId, 'chatId') ? { chatId: optionalIdentifier(input.chatId, 'chatId') } : {}),
    ...(optionalIdentifier(input.runId, 'runId') ? { runId: optionalIdentifier(input.runId, 'runId') } : {}),
    ...(optionalIdentifier(input.projectId, 'projectId') ? { projectId: optionalIdentifier(input.projectId, 'projectId') } : {}),
    ...(optionalIdentifier(input.sessionId, 'sessionId') ? { sessionId: optionalIdentifier(input.sessionId, 'sessionId') } : {}),
    ...(optionalIdentifier(input.pluginId, 'pluginId') ? { pluginId: optionalIdentifier(input.pluginId, 'pluginId') } : {}),
  };
}

function optionalInteger(value: unknown, label: string, maximum?: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function sessionQuery(argumentsValue: unknown): SessionQuery {
  const input = asRecord(argumentsValue, 'arguments');
  const allowed = new Set(['scope', 'limit', 'beforeSequence']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}.`);
  return {
    scope: scopeFrom(input.scope),
    ...(input.limit === undefined ? {} : { limit: optionalInteger(input.limit, 'limit', 200) }),
    ...(input.beforeSequence === undefined ? {} : { beforeSequence: optionalInteger(input.beforeSequence, 'beforeSequence') }),
  };
}

function summaryScope(argumentsValue: unknown): OperationalLedgerScope {
  const input = asRecord(argumentsValue, 'arguments');
  const allowed = new Set(['scope']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}.`);
  return scopeFrom(input.scope);
}

function validateArgumentsSize(value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
  if (bytes > MAX_ARGUMENT_BYTES) throw new Error('Tool arguments exceed the 128 KB gateway limit.');
}

export class McpGatewayProtocol {
  constructor(private readonly retrieval: OperationalLedgerRetrieval) {}

  listTools(): McpGatewayTool[] {
    return tools.map((tool) => structuredClone(tool));
  }

  handle(request: McpJsonRpcRequest, context: McpGatewayClientContext = {}): McpJsonRpcResponse | undefined {
    const id = request.id ?? null;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !request.method) return rpcError(id, -32600, 'Invalid Request');

    try {
      if (request.method === 'initialize') {
        const params = asRecord(request.params, 'initialize params');
        const requestedVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        if (!LEGACY_PROTOCOL_VERSIONS.has(requestedVersion)) {
          return rpcError(id, -32602, 'Unsupported legacy MCP protocol version.');
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requestedVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'Auto CodeZ MCP Gateway', version: '0.1.0' },
            instructions: 'Auto CodeZ exposes bounded operational retrieval tools. Mutating tools are not enabled in this gateway phase.',
          },
        };
      }

      if (request.method === 'notifications/initialized') return undefined;

      if (request.method === 'server/discover') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_GATEWAY_PROTOCOL_VERSION,
            serverInfo: { name: 'Auto CodeZ MCP Gateway', version: '0.1.0' },
            capabilities: { tools: { listChanged: false } },
          },
        };
      }

      if (request.method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: this.listTools() } };
      }

      if (request.method !== 'tools/call') return rpcError(id, -32601, 'Method not found.');

      const params = asRecord(request.params, 'tools/call params');
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      if (!name || name.length > 128) return rpcError(id, -32602, 'Invalid tool name.');
      validateArgumentsSize(params.arguments);

      let result: OperationalSessionSummary | OperationalLedgerPage;
      if (name === 'session_summary') {
        result = this.retrieval.sessionSummary(summaryScope(params.arguments));
      } else {
        const query = sessionQuery(params.arguments);
        if (name === 'session_recent_events') result = this.retrieval.recentEvents(query.scope, query.limit, query.beforeSequence);
        else if (name === 'session_changes') result = this.retrieval.changes(query.scope, query.limit, query.beforeSequence);
        else if (name === 'session_errors') result = this.retrieval.errors(query.scope, query.limit, query.beforeSequence);
        else if (name === 'session_artifacts') result = this.retrieval.artifacts(query.scope, query.limit, query.beforeSequence);
        else if (name === 'session_sources') result = this.retrieval.sources(query.scope, query.limit, query.beforeSequence);
        else return rpcError(id, -32602, `Unknown tool: ${name}.`);
      }

      return { jsonrpc: '2.0', id, result: toolResult(result) };
    } catch (error) {
      return rpcError(id, -32602, error instanceof Error ? error.message.slice(0, 2048) : String(error).slice(0, 2048));
    }
  }
}
