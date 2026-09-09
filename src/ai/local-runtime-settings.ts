export type LocalRuntimeId = 'ollama' | 'lm-studio';

export type LocalRuntimeConnection = {
  endpoint: string;
  apiToken?: string;
};

export type LocalRuntimeSettingsSummary = {
  runtimeId: LocalRuntimeId;
  displayName: string;
  endpoint: string;
  tokenSupported: boolean;
  tokenConfigured: boolean;
};

export type LocalRuntimeSettingsInput = {
  runtimeId: LocalRuntimeId;
  endpoint: string;
  apiToken?: string;
  clearToken?: boolean;
};

type RuntimeMetadata = {
  endpoint: string;
};

type PersistedMetadata = {
  version: 1;
  runtimes: Partial<Record<LocalRuntimeId, RuntimeMetadata>>;
};

type PersistedSecrets = {
  version: 1;
  apiTokens: Partial<Record<LocalRuntimeId, string>>;
};

export interface LocalRuntimeSettingsStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
  readEncrypted(name: string): Promise<string | null>;
  writeEncrypted(name: string, value: string): Promise<void>;
}

const METADATA_FILE = 'local-runtime-settings.json';
const SECRETS_FILE = 'local-runtime-secrets.json';
const VERSION = 1 as const;

const RUNTIME_INFO: Record<LocalRuntimeId, { displayName: string; endpoint: string; tokenSupported: boolean }> = {
  ollama: { displayName: 'Ollama', endpoint: 'http://127.0.0.1:11434', tokenSupported: false },
  'lm-studio': { displayName: 'LM Studio', endpoint: 'http://127.0.0.1:1234', tokenSupported: true },
};

const activeConnections: Record<LocalRuntimeId, LocalRuntimeConnection> = {
  ollama: { endpoint: RUNTIME_INFO.ollama.endpoint },
  'lm-studio': {
    endpoint: RUNTIME_INFO['lm-studio'].endpoint,
    ...(process.env.LM_API_TOKEN?.trim() ? { apiToken: process.env.LM_API_TOKEN.trim() } : {}),
  },
};

function requireRuntimeId(value: string): LocalRuntimeId {
  if (value === 'ollama' || value === 'lm-studio') return value;
  throw new Error('Runtime local inválido.');
}

function normalizeEndpoint(runtimeId: LocalRuntimeId, value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('Endpoint do runtime local é obrigatório.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Endpoint do runtime local inválido.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('O endpoint local precisa usar HTTP ou HTTPS.');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && hostname !== '[::1]') {
    throw new Error('Por segurança, runtimes locais só podem usar endereço de loopback.');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== '/' && !(runtimeId === 'lm-studio' && pathname.toLowerCase() === '/v1')) {
    throw new Error('O endpoint do runtime deve apontar para a raiz local do servidor.');
  }
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (token.length > 4096) throw new Error('Token local excede o tamanho permitido.');
  return token;
}

function cloneConnection(value: LocalRuntimeConnection): LocalRuntimeConnection {
  return { endpoint: value.endpoint, ...(value.apiToken ? { apiToken: value.apiToken } : {}) };
}

function publishConnections(connections: Record<LocalRuntimeId, LocalRuntimeConnection>): void {
  activeConnections.ollama = cloneConnection(connections.ollama);
  activeConnections['lm-studio'] = cloneConnection(connections['lm-studio']);
}

export function getLocalRuntimeConnection(runtimeId: LocalRuntimeId): LocalRuntimeConnection {
  return cloneConnection(activeConnections[runtimeId]);
}

export class LocalRuntimeSettingsStore {
  private connections: Record<LocalRuntimeId, LocalRuntimeConnection> = {
    ollama: { endpoint: RUNTIME_INFO.ollama.endpoint },
    'lm-studio': {
      endpoint: RUNTIME_INFO['lm-studio'].endpoint,
      ...(process.env.LM_API_TOKEN?.trim() ? { apiToken: process.env.LM_API_TOKEN.trim() } : {}),
    },
  };

  constructor(private readonly storage: LocalRuntimeSettingsStorage) {}

  async init(): Promise<void> {
    const metadata = await this.storage.read<PersistedMetadata>(METADATA_FILE, { version: VERSION, runtimes: {} });
    let secrets: PersistedSecrets = { version: VERSION, apiTokens: {} };
    const encrypted = await this.storage.readEncrypted(SECRETS_FILE);
    if (encrypted) {
      try {
        const parsed = JSON.parse(encrypted) as PersistedSecrets;
        if (parsed?.version === VERSION && parsed.apiTokens && typeof parsed.apiTokens === 'object') secrets = parsed;
      } catch {
        secrets = { version: VERSION, apiTokens: {} };
      }
    }

    const next = {} as Record<LocalRuntimeId, LocalRuntimeConnection>;
    for (const runtimeId of ['ollama', 'lm-studio'] as const) {
      const storedEndpoint = metadata?.version === VERSION ? metadata.runtimes?.[runtimeId]?.endpoint : undefined;
      let endpoint = RUNTIME_INFO[runtimeId].endpoint;
      if (typeof storedEndpoint === 'string') {
        try { endpoint = normalizeEndpoint(runtimeId, storedEndpoint); } catch { endpoint = RUNTIME_INFO[runtimeId].endpoint; }
      }
      const token = RUNTIME_INFO[runtimeId].tokenSupported
        ? normalizeToken(secrets.apiTokens?.[runtimeId]) || (runtimeId === 'lm-studio' ? normalizeToken(process.env.LM_API_TOKEN) : undefined)
        : undefined;
      next[runtimeId] = { endpoint, ...(token ? { apiToken: token } : {}) };
    }
    this.connections = next;
    publishConnections(this.connections);
  }

  list(): LocalRuntimeSettingsSummary[] {
    return (['ollama', 'lm-studio'] as const).map((runtimeId) => {
      const info = RUNTIME_INFO[runtimeId];
      const connection = this.connections[runtimeId];
      return {
        runtimeId,
        displayName: info.displayName,
        endpoint: connection.endpoint,
        tokenSupported: info.tokenSupported,
        tokenConfigured: Boolean(connection.apiToken),
      };
    });
  }

  get(runtimeId: string): LocalRuntimeConnection {
    return cloneConnection(this.connections[requireRuntimeId(runtimeId)]);
  }

  async save(input: LocalRuntimeSettingsInput): Promise<LocalRuntimeSettingsSummary> {
    const runtimeId = requireRuntimeId(input.runtimeId);
    const info = RUNTIME_INFO[runtimeId];
    if (input.apiToken !== undefined && !info.tokenSupported) throw new Error(`${info.displayName} não usa token neste modo local.`);
    if (input.apiToken !== undefined && input.clearToken) throw new Error('Escolha entre salvar ou limpar o token local.');

    const previous = this.connections[runtimeId];
    const endpoint = normalizeEndpoint(runtimeId, input.endpoint);
    const explicitToken = normalizeToken(input.apiToken);
    const apiToken = info.tokenSupported
      ? input.clearToken
        ? undefined
        : input.apiToken !== undefined
          ? explicitToken
          : previous.apiToken
      : undefined;

    this.connections = {
      ...this.connections,
      [runtimeId]: { endpoint, ...(apiToken ? { apiToken } : {}) },
    };
    await this.persist();
    publishConnections(this.connections);
    return this.list().find((item) => item.runtimeId === runtimeId)!;
  }

  private async persist(): Promise<void> {
    const metadata: PersistedMetadata = {
      version: VERSION,
      runtimes: {
        ollama: { endpoint: this.connections.ollama.endpoint },
        'lm-studio': { endpoint: this.connections['lm-studio'].endpoint },
      },
    };
    const secrets: PersistedSecrets = {
      version: VERSION,
      apiTokens: {
        ...(this.connections['lm-studio'].apiToken ? { 'lm-studio': this.connections['lm-studio'].apiToken } : {}),
      },
    };
    await this.storage.write(METADATA_FILE, metadata);
    await this.storage.writeEncrypted(SECRETS_FILE, JSON.stringify(secrets));
  }
}
