import crypto from 'node:crypto';
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const electronSecureStorage: SecureStorageAdapter = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
};

const SENSITIVE_JSON_FILES = new Set([
  'agent-runs.json',
  'tool-execution-journal.json',
]);

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class LocalStorage {
  constructor(
    private readonly rootPath?: string,
    private readonly secureStorage: SecureStorageAdapter = electronSecureStorage,
  ) {}

  private get root(): string {
    return this.rootPath || path.join(app.getPath('userData'), 'data');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private file(name: string): string {
    if (path.basename(name) !== name) throw new Error('Nome de armazenamento inválido.');
    return path.join(this.root, name);
  }

  private temporaryFile(name: string): string {
    return path.join(this.root, `.${name}.${crypto.randomUUID()}.tmp`);
  }

  private async readPlain<T>(name: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.file(name), 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    if (!SENSITIVE_JSON_FILES.has(name)) return this.readPlain(name, fallback);

    try {
      const encrypted = await this.readEncrypted(name);
      if (encrypted !== null) return JSON.parse(encrypted) as T;
    } catch {
      // A legacy plaintext file is migrated on the next write.
    }

    return this.readPlain(name, fallback);
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (SENSITIVE_JSON_FILES.has(name)) {
      await this.writeEncrypted(name, JSON.stringify(value));
      return;
    }

    await fs.mkdir(this.root, { recursive: true });
    const destination = this.file(name);
    const temporary = this.temporaryFile(name);
    const serialized = JSON.stringify(value, null, 2);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Cleanup is best-effort after a failed persistence operation.
        }
      }
      try {
        await fs.rm(temporary, { force: true });
      } catch {
        // Cleanup is best-effort after a failed persistence operation.
      }
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await fs.rm(this.file(name), { force: true });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async readEncrypted(name: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.file(name), 'utf8');
      if (!this.secureStorage.isEncryptionAvailable()) return null;
      return this.secureStorage.decrypt(Buffer.from(raw, 'base64'));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async writeEncrypted(name: string, value: string): Promise<void> {
    if (!this.secureStorage.isEncryptionAvailable()) throw new Error('Sistema de armazenamento seguro indisponível.');
    await fs.mkdir(this.root, { recursive: true });
    const destination = this.file(name);
    const temporary = this.temporaryFile(name);
    const encrypted = this.secureStorage.encrypt(value).toString('base64');
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(encrypted, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Cleanup is best-effort after a failed persistence operation.
        }
      }
      try {
        await fs.rm(temporary, { force: true });
      } catch {
        // Cleanup is best-effort after a failed persistence operation.
      }
    }
  }
}
