import type { DeviceId } from './types';

export interface RemoteDeviceRecord {
  id: DeviceId;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface BeginDeviceRegistrationInput {
  accessToken: string;
  device: {
    id: DeviceId;
    name: string;
    platform: NodeJS.Platform;
    arch: string;
    appVersion: string;
    publicKey: string;
  };
}

export interface CompleteDeviceRegistrationInput {
  accessToken: string;
  registrationId: string;
  deviceId: DeviceId;
  signature: string;
}

export type DeviceRequestProofSigner = (challenge: string) => Promise<{
  deviceId: DeviceId;
  signature: string;
}>;

export type DeviceRegistryAdapterErrorCode = 'offline' | 'unauthorized' | 'forbidden' | 'revoked' | 'server' | 'not_configured';

export class DeviceRegistryAdapterError extends Error {
  constructor(
    public readonly code: DeviceRegistryAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceRegistryAdapterError';
  }
}

export interface DeviceRegistryAdapter {
  beginRegistration(input: BeginDeviceRegistrationInput): Promise<{
    registrationId: string;
    challenge: string;
    expiresAt: number;
  }>;
  completeRegistration(input: CompleteDeviceRegistrationInput): Promise<RemoteDeviceRecord>;
  list(accessToken: string): Promise<RemoteDeviceRecord[]>;
  rename(accessToken: string, deviceId: DeviceId, name: string): Promise<RemoteDeviceRecord>;
  revoke(accessToken: string, deviceId: DeviceId): Promise<void>;
}

export class UnavailableDeviceRegistryAdapter implements DeviceRegistryAdapter {
  private unavailable(): never {
    throw new DeviceRegistryAdapterError('not_configured', 'Device Registry ainda não está configurado.');
  }

  async beginRegistration(): Promise<{ registrationId: string; challenge: string; expiresAt: number }> {
    return this.unavailable();
  }

  async completeRegistration(): Promise<RemoteDeviceRecord> {
    return this.unavailable();
  }

  async list(): Promise<RemoteDeviceRecord[]> {
    return this.unavailable();
  }

  async rename(): Promise<RemoteDeviceRecord> {
    return this.unavailable();
  }

  async revoke(): Promise<void> {
    return this.unavailable();
  }
}
