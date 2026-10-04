import type { LocalStorage } from '../core/storage';
import { SecretVault, type SecretMetadata } from './secret-vault';

export type ProtectedCredentialMetadata = SecretMetadata;

export interface ProtectedCredentialStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  remove(key: string): Promise<boolean>;
  listMetadata(): Promise<ProtectedCredentialMetadata[]>;
}

export class LocalProtectedCredentialStore implements ProtectedCredentialStore {
  private readonly vault: SecretVault;

  constructor(storage: LocalStorage) {
    this.vault = new SecretVault(storage);
  }

  async set(key: string, value: string): Promise<void> {
    await this.vault.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return await this.vault.get(key);
  }

  async remove(key: string): Promise<boolean> {
    return await this.vault.remove(key);
  }

  async listMetadata(): Promise<ProtectedCredentialMetadata[]> {
    return await this.vault.listMetadata();
  }
}
