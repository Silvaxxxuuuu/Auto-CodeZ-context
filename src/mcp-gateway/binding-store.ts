import type { LocalStorage } from '../core/storage';

const STORAGE_FILE = 'mcp-gateway-binding.json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export type McpGatewayBridgeBinding = {
  endpoint: string;
  bearerToken: string;
  ownerPid: number;
  updatedAt: number;
};

function normalizeBinding(value: unknown): McpGatewayBridgeBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.endpoint !== 'string' || typeof input.bearerToken !== 'string') return undefined;
  if (!Number.isInteger(input.ownerPid) || Number(input.ownerPid) <= 0) return undefined;
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt) || input.updatedAt < 0) return undefined;

  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== '/mcp') return undefined;
  if (input.bearerToken.length < 32 || input.bearerToken.length > 256 || /[\u0000-\u001f\u007f\s]/.test(input.bearerToken)) return undefined;

  return {
    endpoint: url.toString(),
    bearerToken: input.bearerToken,
    ownerPid: Number(input.ownerPid),
    updatedAt: input.updatedAt,
  };
}

export class McpGatewayBindingStore {
  constructor(
    private readonly storage: LocalStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<McpGatewayBridgeBinding | undefined> {
    const stored = await this.storage.read<unknown>(STORAGE_FILE, null);
    return normalizeBinding(stored);
  }

  async write(input: Omit<McpGatewayBridgeBinding, 'updatedAt'>): Promise<McpGatewayBridgeBinding> {
    const binding = normalizeBinding({ ...input, updatedAt: this.now() });
    if (!binding) throw new Error('Binding MCP local inválido.');
    await this.storage.write(STORAGE_FILE, binding);
    return { ...binding };
  }

  async clear(): Promise<void> {
    await this.storage.remove(STORAGE_FILE);
  }
}
