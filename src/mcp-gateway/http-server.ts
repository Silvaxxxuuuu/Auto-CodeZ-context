import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { McpGatewayProtocol, MCP_GATEWAY_PROTOCOL_VERSION, type McpJsonRpcRequest } from './protocol';

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOST = '127.0.0.1';
const MAX_REQUEST_ID_LENGTH = 160;
const MAX_METHOD_LENGTH = 128;
const MAX_CONNECTIONS = 32;

export type McpGatewayServerInfo = {
  host: string;
  port: number;
  endpoint: string;
  bearerToken: string;
};

export type McpGatewayPreflightResult = {
  ok: true;
  protocolVersion: string;
  toolCount: number;
  writeToolCount: number;
};

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('MCP request body exceeds 1 MB.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('MCP request body is not valid JSON.');
  }
}

function validBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length);
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return expected.byteLength === actual.byteLength && crypto.timingSafeEqual(expected, actual);
}

function requestObject(value: unknown): McpJsonRpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP JSON-RPC request must be an object.');
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string' || !record.method || record.method.length > MAX_METHOD_LENGTH || /[\u0000-\u001f\u007f]/.test(record.method)) {
    throw new Error('Invalid MCP JSON-RPC request.');
  }
  if (record.id !== undefined && record.id !== null && typeof record.id !== 'string' && typeof record.id !== 'number') throw new Error('Invalid MCP request id.');
  if (typeof record.id === 'string' && (!record.id || record.id.length > MAX_REQUEST_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(record.id))) {
    throw new Error('Invalid MCP request id.');
  }
  if (typeof record.id === 'number' && (!Number.isFinite(record.id) || !Number.isSafeInteger(record.id))) throw new Error('Invalid MCP request id.');
  return {
    jsonrpc: '2.0',
    ...(record.id === undefined ? {} : { id: record.id as string | number | null }),
    method: record.method,
    ...(Object.prototype.hasOwnProperty.call(record, 'params') ? { params: record.params } : {}),
  };
}

export class McpGatewayHttpServer {
  private server?: http.Server;
  private info?: McpGatewayServerInfo;

  constructor(private readonly protocol: McpGatewayProtocol) {}

  async start(options: { port?: number; bearerToken?: string } = {}): Promise<McpGatewayServerInfo> {
    if (this.server) throw new Error('MCP Gateway HTTP server is already running.');
    const requestedPort = options.port ?? 0;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('MCP Gateway port is invalid.');
    const bearerToken = options.bearerToken ?? crypto.randomBytes(32).toString('base64url');
    if (bearerToken.length < 32 || bearerToken.length > 256 || /[\u0000-\u001f\u007f\s]/.test(bearerToken)) throw new Error('MCP Gateway bearer token is invalid.');

    const server = http.createServer((request, response) => {
      void this.handleHttp(request, response, bearerToken);
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = MAX_CONNECTIONS;
    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, LOOPBACK_HOST, () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('MCP Gateway did not bind to a TCP address.');
    }

    this.server = server;
    this.info = {
      host: LOOPBACK_HOST,
      port: address.port,
      endpoint: `http://${LOOPBACK_HOST}:${address.port}/mcp`,
      bearerToken,
    };
    return { ...this.info };
  }

  status(): Omit<McpGatewayServerInfo, 'bearerToken'> & { running: boolean } {
    if (!this.info || !this.server) return { running: false, host: LOOPBACK_HOST, port: 0, endpoint: '' };
    return { running: true, host: this.info.host, port: this.info.port, endpoint: this.info.endpoint };
  }

  trustedTunnelBinding(): { endpoint: string; bearerToken: string } {
    if (!this.info || !this.server) throw new Error('MCP Gateway local não está em execução.');
    return { endpoint: this.info.endpoint, bearerToken: this.info.bearerToken };
  }

  async preflight(): Promise<McpGatewayPreflightResult> {
    const binding = this.trustedTunnelBinding();
    const call = async (id: string, method: string): Promise<Record<string, unknown>> => {
      const response = await fetch(binding.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${binding.bearerToken}`,
          'mcp-protocol-version': MCP_GATEWAY_PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`MCP Gateway preflight ${method} retornou HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('application/json')) throw new Error(`MCP Gateway preflight ${method} retornou Content-Type incompatível.`);
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`MCP Gateway preflight ${method} retornou JSON-RPC inválido.`);
      const record = payload as Record<string, unknown>;
      if (record.error) throw new Error(`MCP Gateway preflight ${method} retornou erro JSON-RPC.`);
      if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) throw new Error(`MCP Gateway preflight ${method} não retornou result válido.`);
      return record.result as Record<string, unknown>;
    };

    const discovery = await call('autocodez-preflight-discover', 'server/discover');
    if (discovery.protocolVersion !== MCP_GATEWAY_PROTOCOL_VERSION) {
      throw new Error('MCP Gateway preflight recebeu versão de protocolo inesperada.');
    }

    const listed = await call('autocodez-preflight-tools', 'tools/list');
    if (!Array.isArray(listed.tools)) throw new Error('MCP Gateway preflight tools/list não retornou catálogo válido.');
    let writeToolCount = 0;
    for (const rawTool of listed.tools) {
      if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) throw new Error('MCP Gateway preflight encontrou tool inválida.');
      const tool = rawTool as Record<string, unknown>;
      if (typeof tool.name !== 'string' || !tool.name) throw new Error('MCP Gateway preflight encontrou tool sem nome.');
      const annotations = tool.annotations;
      if (annotations && typeof annotations === 'object' && !Array.isArray(annotations)) {
        const values = annotations as Record<string, unknown>;
        if (values.readOnlyHint === false || values.destructiveHint === true) writeToolCount += 1;
      }
    }

    return {
      ok: true,
      protocolVersion: MCP_GATEWAY_PROTOCOL_VERSION,
      toolCount: listed.tools.length,
      writeToolCount,
    };
  }

  async stop(): Promise<boolean> {
    const server = this.server;
    this.server = undefined;
    this.info = undefined;
    if (!server) return false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse, bearerToken: string): Promise<void> {
    response.setHeader('access-control-allow-origin', 'null');
    if (request.url === '/health' && request.method === 'GET') {
      json(response, 200, { ok: true, service: 'auto-codez-mcp-gateway', protocolVersion: MCP_GATEWAY_PROTOCOL_VERSION });
      return;
    }

    if (request.url !== '/mcp') {
      json(response, 404, { error: 'Not found.' });
      return;
    }

    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      json(response, 405, { error: 'Method not allowed.' });
      return;
    }

    if (!validBearer(request.headers.authorization, bearerToken)) {
      response.setHeader('www-authenticate', 'Bearer realm="Auto CodeZ MCP Gateway"');
      json(response, 401, { error: 'Unauthorized.' });
      return;
    }

    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      json(response, 415, { error: 'Content-Type must be application/json.' });
      return;
    }

    const protocolVersion = typeof request.headers['mcp-protocol-version'] === 'string'
      ? request.headers['mcp-protocol-version']
      : undefined;

    try {
      const raw = await readJson(request);
      const rpc = requestObject(raw);
      const result = await this.protocol.handle(rpc, { protocolVersion });
      if (!result) {
        response.writeHead(202, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      json(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2048) : String(error).slice(0, 2048);
      json(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message } });
    }
  }
}
