import { LocalStorage } from '../core/storage';

export interface SecretMetadata {
  key: string;
  updatedAt: number;
}

interface SecretRecord {
  value: string;
  updatedAt: number;
}

type SecretMap = Record<string, SecretRecord>;

const STORAGE_FILE = 'account-secrets.enc';

export class SecretVault {
  constructor(private readonly storage: LocalStorage) {}

  async set(key: string, value: string): Promise<void> {
    this.assertKey(key);
    if (!value) throw new Error('O secret não pode estar vazio.');
    const secrets = await this.readAll();
    secrets[key] = { value, updatedAt: Date.now() };
    await this.storage.writeEncrypted(STORAGE_FILE, JSON.stringify(secrets));
  }

  async get(key: string): Promise<string | null> {
    this.assertKey(key);
    const secrets = await this.readAll();
    return secrets[key]?.value ?? null;
  }

  async remove(key: string): Promise<boolean> {
    this.assertKey(key);
    const secrets = await this.readAll();
    if (!(key in secrets)) return false;
    delete secrets[key];
    await this.storage.writeEncrypted(STORAGE_FILE, JSON.stringify(secrets));
    return true;
  }

  async listMetadata(): Promise<SecretMetadata[]> {
    const secrets = await this.readAll();
    return Object.entries(secrets).sort(([left], [right]) => left.localeCompare(right)).map(([key, record]) => ({ key, updatedAt: record.updatedAt }));
  }

  private async readAll(): Promise<SecretMap> {
    const raw = await this.storage.readEncrypted(STORAGE_FILE);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Formato de secrets inválido.');
      const result: SecretMap = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Formato de secret inválido.');
        const record = value as { value?: unknown; updatedAt?: unknown };
        if (typeof record.value !== 'string' || typeof record.updatedAt !== 'number') throw new Error('Formato de secret inválido.');
        result[key] = { value: record.value, updatedAt: record.updatedAt };
      }
      return result;
    } catch (error) {
      throw error instanceof Error ? error : new Error('Não foi possível ler os secrets locais.');
    }
  }

  private assertKey(key: string): void {
    if (!key.trim() || key.length > 256 || key.includes('/') || key.includes('\\')) throw new Error('Identificador de secret inválido.');
  }
}
