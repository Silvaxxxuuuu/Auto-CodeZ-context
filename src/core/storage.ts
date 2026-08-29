import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export class LocalStorage {
  private get root(): string {
    return path.join(app.getPath('userData'), 'data');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private file(name: string): string {
    if (path.basename(name) !== name) throw new Error('Nome de armazenamento inválido.');
    return path.join(this.root, name);
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(this.file(name), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async write<T>(name: string, value: T): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(this.file(name), JSON.stringify(value, null, 2), 'utf8');
  }

  async readEncrypted(name: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.file(name), 'utf8');
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(raw, 'base64'));
    } catch {
      return null;
    }
  }

  async writeEncrypted(name: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Sistema de armazenamento seguro indisponível.');
    await fs.mkdir(this.root, { recursive: true });
    const encrypted = safeStorage.encryptString(value).toString('base64');
    await fs.writeFile(this.file(name), encrypted, 'utf8');
  }
}
