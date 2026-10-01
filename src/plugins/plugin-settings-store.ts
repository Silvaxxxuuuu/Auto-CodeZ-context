const STORAGE_FILE = 'plugin-settings.json';
const MAX_PLUGIN_SETTINGS_BYTES = 64 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PluginSettingsStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

type SettingsDocument = Record<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Valor de configuração inválido.');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PLUGIN_SETTINGS_BYTES) {
    throw new Error('Configuração do plugin excede o limite de 64 KB.');
  }
  return JSON.parse(serialized) as unknown;
}

function validateKey(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error('Chave de configuração do plugin inválida.');
  return key;
}

function sanitizeDocument(value: unknown): SettingsDocument {
  if (!isRecord(value)) return {};
  const output: SettingsDocument = {};
  for (const [pluginId, settings] of Object.entries(value)) {
    if (!KEY_PATTERN.test(pluginId) || !isRecord(settings)) continue;
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(settings)) {
      if (!KEY_PATTERN.test(key)) continue;
      try {
        safe[key] = validateValue(item);
      } catch {
      }
    }
    output[pluginId] = safe;
  }
  return output;
}

export class PluginSettingsStore {
  private document: SettingsDocument = {};
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: PluginSettingsStorage) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.document = sanitizeDocument(await this.storage.read<unknown>(STORAGE_FILE, {}));
    this.initialized = true;
  }

  get(pluginId: string, key: string): unknown {
    this.requireInitialized();
    return structuredClone(this.document[validateKey(pluginId)]?.[validateKey(key)]);
  }

  list(pluginId: string): Record<string, unknown> {
    this.requireInitialized();
    return structuredClone(this.document[validateKey(pluginId)] ?? {});
  }

  async set(pluginId: string, key: string, value: unknown): Promise<void> {
    this.requireInitialized();
    const id = validateKey(pluginId);
    const normalizedKey = validateKey(key);
    const normalizedValue = validateValue(value);
    const next = structuredClone(this.document);
    next[id] = { ...(next[id] ?? {}), [normalizedKey]: normalizedValue };
    this.assertPluginSize(next[id]);
    this.document = next;
    await this.persist();
  }

  async remove(pluginId: string, key: string): Promise<void> {
    this.requireInitialized();
    const id = validateKey(pluginId);
    const normalizedKey = validateKey(key);
    const next = structuredClone(this.document);
    if (!next[id]) return;
    delete next[id][normalizedKey];
    if (!Object.keys(next[id]).length) delete next[id];
    this.document = next;
    await this.persist();
  }

  async clear(pluginId: string): Promise<void> {
    this.requireInitialized();
    const id = validateKey(pluginId);
    if (!this.document[id]) return;
    const next = structuredClone(this.document);
    delete next[id];
    this.document = next;
    await this.persist();
  }

  private assertPluginSize(settings: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(settings), 'utf8');
    if (bytes > MAX_PLUGIN_SETTINGS_BYTES) throw new Error('Configurações do plugin excedem o limite de 64 KB.');
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.document);
    const task = this.writeQueue.then(() => this.storage.write(STORAGE_FILE, snapshot));
    this.writeQueue = task.catch((): undefined => undefined);
    await task;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Configurações de plugins ainda não foram inicializadas.');
  }
}
