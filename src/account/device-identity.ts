import crypto from 'node:crypto';
import type { DeviceId, DeviceRecord } from './types';
import type { LocalStorage } from '../core/storage';
import type { ProtectedCredentialStore } from './protected-credential-store';

interface StoredDeviceIdentity {
  id: DeviceId;
  name: string;
  publicKey: string;
  createdAt: number;
}

export interface DeviceIdentityOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  appVersion?: string;
  defaultName?: string;
  now?: () => number;
}

const STORAGE_FILE = 'device-identity.json';
const PRIVATE_KEY_CREDENTIAL = 'account.device.private-key';

function sanitizeDeviceName(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  if (!normalized) return 'Este dispositivo';
  return normalized.slice(0, 80);
}

function generateIdentity(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export class DeviceIdentityStore {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly appVersion: string;
  private readonly defaultName: string;
  private readonly now: () => number;

  constructor(
    private readonly storage: LocalStorage,
    private readonly credentials: ProtectedCredentialStore,
    options: DeviceIdentityOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.appVersion = options.appVersion ?? 'unknown';
    this.defaultName = sanitizeDeviceName(options.defaultName);
    this.now = options.now ?? Date.now;
  }

  async getOrCreate(): Promise<DeviceRecord> {
    const now = this.now();
    let stored = await this.storage.read<StoredDeviceIdentity | null>(STORAGE_FILE, null);
    const privateKey = await this.credentials.get(PRIVATE_KEY_CREDENTIAL);

    if (!stored || !privateKey) {
      const keys = generateIdentity();
      stored = {
        id: crypto.randomUUID(),
        name: this.defaultName,
        publicKey: keys.publicKey,
        createdAt: now,
      };
      await this.credentials.set(PRIVATE_KEY_CREDENTIAL, keys.privateKey);
      await this.storage.write(STORAGE_FILE, stored);
    }

    return this.toRecord(stored, now);
  }

  async rename(name: string): Promise<DeviceRecord> {
    const current = await this.getOrCreate();
    const stored: StoredDeviceIdentity = {
      id: current.id,
      name: sanitizeDeviceName(name),
      publicKey: current.publicKey,
      createdAt: current.createdAt,
    };
    await this.storage.write(STORAGE_FILE, stored);
    return this.toRecord(stored, this.now());
  }

  async signChallenge(challenge: string): Promise<string> {
    const value = challenge.trim();
    if (!value || value.length > 16_384) throw new Error('Desafio do dispositivo inválido.');

    await this.getOrCreate();
    const privateKey = await this.credentials.get(PRIVATE_KEY_CREDENTIAL);
    if (!privateKey) throw new Error('Credencial privada do dispositivo indisponível.');

    return crypto.sign(null, Buffer.from(value, 'utf8'), privateKey).toString('base64');
  }

  private toRecord(identity: StoredDeviceIdentity, now: number): DeviceRecord {
    return {
      id: identity.id,
      name: identity.name,
      platform: this.platform,
      arch: this.arch,
      appVersion: this.appVersion,
      publicKey: identity.publicKey,
      createdAt: identity.createdAt,
      lastSeenAt: now,
      isCurrent: true,
    };
  }
}

export function suggestDeviceName(displayName: string): string {
  const normalized = displayName.trim().replace(/\s+/g, ' ');
  return sanitizeDeviceName(normalized || 'Este dispositivo');
}
