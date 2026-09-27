import type { LocalStorage } from '../core/storage';

export const MCP_CONNECTION_CLIENT_IDS = ['chatgpt', 'codex', 'claude-desktop', 'claude-code', 'cursor', 'other'] as const;
export type McpConnectionClientId = typeof MCP_CONNECTION_CLIENT_IDS[number];
export type McpConnectionSetupState = 'added' | 'configured';

export type McpConnectionRecord = {
  clientId: McpConnectionClientId;
  setupState: McpConnectionSetupState;
  addedAt: number;
  updatedAt: number;
  configuredAt?: number;
  lastConnectedAt?: number;
  metadata?: {
    tunnelId?: string;
    autoReconnect?: boolean;
  };
};

const STORAGE_FILE = 'mcp-connections.json';
const CLIENT_IDS = new Set<string>(MCP_CONNECTION_CLIENT_IDS);
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

function cloneRecord(record: McpConnectionRecord): McpConnectionRecord {
  return {
    ...record,
    ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
  };
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeRecord(value: unknown): McpConnectionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.clientId !== 'string' || !CLIENT_IDS.has(input.clientId)) return undefined;
  if (input.setupState !== 'added' && input.setupState !== 'configured') return undefined;
  if (!validTimestamp(input.addedAt) || !validTimestamp(input.updatedAt)) return undefined;

  const record: McpConnectionRecord = {
    clientId: input.clientId as McpConnectionClientId,
    setupState: input.setupState,
    addedAt: input.addedAt,
    updatedAt: input.updatedAt,
  };
  if (validTimestamp(input.configuredAt)) record.configuredAt = input.configuredAt;
  if (validTimestamp(input.lastConnectedAt)) record.lastConnectedAt = input.lastConnectedAt;

  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    const metadata = input.metadata as Record<string, unknown>;
    const tunnelId = typeof metadata.tunnelId === 'string' && TUNNEL_ID_PATTERN.test(metadata.tunnelId)
      ? metadata.tunnelId
      : undefined;
    const autoReconnect = typeof metadata.autoReconnect === 'boolean' ? metadata.autoReconnect : undefined;
    if (tunnelId !== undefined || autoReconnect !== undefined) {
      record.metadata = {
        ...(tunnelId ? { tunnelId } : {}),
        ...(autoReconnect !== undefined ? { autoReconnect } : {}),
      };
    }
  }
  return record;
}

function requireClientId(value: string): McpConnectionClientId {
  if (!CLIENT_IDS.has(value)) throw new Error('Cliente MCP inválido.');
  return value as McpConnectionClientId;
}

export class McpConnectionRegistry {
  private readonly records = new Map<McpConnectionClientId, McpConnectionRecord>();
  private hydrated = false;

  constructor(
    private readonly storage: LocalStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<unknown>(STORAGE_FILE, []);
    this.records.clear();
    if (Array.isArray(stored)) {
      for (const value of stored) {
        const record = normalizeRecord(value);
        if (!record) continue;
        const current = this.records.get(record.clientId);
        if (!current || record.updatedAt >= current.updatedAt) this.records.set(record.clientId, record);
      }
    }
    this.hydrated = true;
  }

  list(): McpConnectionRecord[] {
    this.ensureHydrated();
    return [...this.records.values()]
      .sort((left, right) => left.addedAt - right.addedAt || left.clientId.localeCompare(right.clientId))
      .map(cloneRecord);
  }

  get(clientId: string): McpConnectionRecord | undefined {
    this.ensureHydrated();
    const record = this.records.get(requireClientId(clientId));
    return record ? cloneRecord(record) : undefined;
  }

  async add(clientId: string): Promise<McpConnectionRecord> {
    this.ensureHydrated();
    const id = requireClientId(clientId);
    const existing = this.records.get(id);
    if (existing) return cloneRecord(existing);
    const now = this.now();
    const record: McpConnectionRecord = {
      clientId: id,
      setupState: 'added',
      addedAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    await this.persist();
    return cloneRecord(record);
  }

  async remove(clientId: string): Promise<boolean> {
    this.ensureHydrated();
    const removed = this.records.delete(requireClientId(clientId));
    if (removed) await this.persist();
    return removed;
  }

  async markAdded(clientId: string): Promise<McpConnectionRecord> {
    this.ensureHydrated();
    const id = requireClientId(clientId);
    const existing = this.records.get(id) ?? await this.add(id);
    const now = this.now();
    const record: McpConnectionRecord = {
      clientId: existing.clientId,
      setupState: 'added',
      addedAt: existing.addedAt,
      updatedAt: now,
    };
    this.records.set(id, record);
    await this.persist();
    return cloneRecord(record);
  }

  async markConfigured(clientId: string, metadata?: { tunnelId?: string; autoReconnect?: boolean }): Promise<McpConnectionRecord> {
    const id = requireClientId(clientId);
    const tunnelId = metadata?.tunnelId;
    if (tunnelId !== undefined && !TUNNEL_ID_PATTERN.test(tunnelId)) throw new Error('Tunnel ID inválido.');
    const existing = this.records.get(id) ?? await this.add(id);
    const now = this.now();
    const record: McpConnectionRecord = {
      ...existing,
      setupState: 'configured',
      configuredAt: existing.configuredAt ?? now,
      updatedAt: now,
      ...((tunnelId || metadata?.autoReconnect !== undefined)
        ? {
            metadata: {
              ...(existing.metadata ?? {}),
              ...(tunnelId ? { tunnelId } : {}),
              ...(metadata?.autoReconnect !== undefined ? { autoReconnect: metadata.autoReconnect } : {}),
            },
          }
        : {}),
    };
    this.records.set(id, record);
    await this.persist();
    return cloneRecord(record);
  }

  async markConnected(clientId: string, metadata?: { tunnelId?: string }): Promise<McpConnectionRecord> {
    const configured = await this.markConfigured(clientId, {
      ...(metadata ?? {}),
      ...(clientId === 'chatgpt' ? { autoReconnect: true } : {}),
    });
    const now = this.now();
    const record: McpConnectionRecord = {
      ...configured,
      lastConnectedAt: now,
      updatedAt: now,
    };
    this.records.set(record.clientId, record);
    await this.persist();
    return cloneRecord(record);
  }

  async markDisconnected(clientId: string): Promise<McpConnectionRecord> {
    this.ensureHydrated();
    const id = requireClientId(clientId);
    const existing = this.records.get(id) ?? await this.add(id);
    const now = this.now();
    const record: McpConnectionRecord = {
      ...existing,
      updatedAt: now,
      ...(id === 'chatgpt'
        ? { metadata: { ...(existing.metadata ?? {}), autoReconnect: false } }
        : {}),
    };
    this.records.set(id, record);
    await this.persist();
    return cloneRecord(record);
  }

  private ensureHydrated(): void {
    if (!this.hydrated) throw new Error('Registro de conexões MCP ainda não foi inicializado.');
  }

  private async persist(): Promise<void> {
    await this.storage.write(STORAGE_FILE, this.list());
  }
}
