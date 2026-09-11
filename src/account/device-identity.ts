import crypto from 'node:crypto';
import os from 'node:os';
import { app } from 'electron';
import type { DeviceId, DeviceRecord } from './types';
import { LocalStorage } from '../core/storage';

interface StoredDeviceIdentity {
  id: DeviceId;
  createdAt: number;
}

const STORAGE_FILE = 'device-identity.json';

export class DeviceIdentityStore {
  constructor(private readonly storage: LocalStorage) {}

  async getOrCreate(): Promise<DeviceRecord> {
    const now = Date.now();
    const stored = await this.storage.read<StoredDeviceIdentity | null>(STORAGE_FILE, null);
    const identity = stored ?? { id: crypto.randomUUID(), createdAt: now };

    if (!stored) await this.storage.write(STORAGE_FILE, identity);

    return {
      id: identity.id,
      name: os.hostname(),
      platform: process.platform,
      appVersion: app.getVersion(),
      createdAt: identity.createdAt,
      lastSeenAt: now,
      isCurrent: true,
    };
  }
}
