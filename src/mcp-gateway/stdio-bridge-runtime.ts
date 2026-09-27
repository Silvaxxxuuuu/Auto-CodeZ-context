import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { McpGatewayBridgeBinding } from './binding-store';

const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 150;

export type McpBridgeBindingResolver = () => Promise<McpGatewayBridgeBinding | undefined>;
export type McpBridgeLauncher = () => Promise<void> | void;

function sanitizedClientId(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return normalized || 'other';
}

function rpcRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mensagem MCP stdio inválida.');
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string' || !record.method) throw new Error('Mensagem MCP stdio inválida.');
  return record;
}

export class McpStdioBridgeRuntime {
  constructor(
    private readonly resolveBinding: McpBridgeBindingResolver,
    private readonly launchAutoCodeZ: McpBridgeLauncher,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  ) {}

  async run(input: Readable, output: Writable, clientIdInput: string): Promise<void> {
    const clientId = sanitizedClientId(clientIdInput);
    let binding = await this.ensureBinding(clientId);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Mensagem MCP stdio excede o limite de 1 MB.');

      let request: Record<string, unknown>;
      try {
        request = rpcRequest(JSON.parse(line) as unknown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message } }) + '\n');
        continue;
      }

      try {
        const response = await this.forward(binding, request, clientId);
        if (response !== undefined) output.write(JSON.stringify(response) + '\n');
      } catch {
        binding = await this.ensureBinding(clientId, true);
        const response = await this.forward(binding, request, clientId);
        if (response !== undefined) output.write(JSON.stringify(response) + '\n');
      }
    }
  }

  private async ensureBinding(clientId: string, forceLaunch = false): Promise<McpGatewayBridgeBinding> {
    if (!forceLaunch) {
      const existing = await this.resolveBinding();
      if (existing && await this.isReachable(existing, clientId)) return existing;
    }

    await this.launchAutoCodeZ();
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const binding = await this.resolveBinding();
      if (binding && await this.isReachable(binding, clientId)) return binding;
      await this.sleep(RETRY_INTERVAL_MS);
    }
    throw new Error('Auto CodeZ não iniciou o MCP local dentro do tempo esperado.');
  }

  private async isReachable(binding: McpGatewayBridgeBinding, clientId: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(binding.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${binding.bearerToken}`,
          'x-auto-codez-mcp-client': clientId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'autocodez-bridge-probe', method: 'server/discover', params: {} }),
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async forward(binding: McpGatewayBridgeBinding, request: Record<string, unknown>, clientId: string): Promise<unknown | undefined> {
    const response = await this.fetchImpl(binding.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${binding.bearerToken}`,
        'x-auto-codez-mcp-client': clientId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 202) return undefined;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP Gateway retornou HTTP ${response.status}.`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('MCP Gateway retornou JSON inválido.');
    }
  }
}
