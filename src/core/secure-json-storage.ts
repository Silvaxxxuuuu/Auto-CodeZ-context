export interface SecureJsonBacking {
  read<T>(name: string, fallback: T): Promise<T>;
  remove(name: string): Promise<void>;
  readEncrypted(name: string): Promise<string | null>;
  writeEncrypted(name: string, value: string): Promise<void>;
}

export class SecureJsonStorage {
  constructor(
    private readonly backing: SecureJsonBacking,
    private readonly prefix = 'secure-',
  ) {}

  private secureName(name: string): string {
    return `${this.prefix}${name}`;
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    const encrypted = await this.backing.readEncrypted(this.secureName(name));
    if (encrypted !== null) {
      try {
        return JSON.parse(encrypted) as T;
      } catch {
        return fallback;
      }
    }

    return this.backing.read(name, fallback);
  }

  async write<T>(name: string, value: T): Promise<void> {
    await this.backing.writeEncrypted(this.secureName(name), JSON.stringify(value));
    await this.backing.remove(name);
  }
}
