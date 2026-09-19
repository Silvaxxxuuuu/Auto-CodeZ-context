import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { LocalStorage } from '../src/core/storage';
import type { ProtectedCredentialStore } from '../src/account/protected-credential-store';
import { DeviceIdentityStore } from '../src/account/device-identity';
import { AccountSessionRuntime } from '../src/account/account-session-runtime';
import { DeviceRegistryRuntime } from '../src/account/device-registry-runtime';
import type {
  BeginDeviceRegistrationInput,
  CompleteDeviceRegistrationInput,
  DeviceRegistryAdapter,
  RemoteDeviceRecord,
} from '../src/account/device-registry-adapter';
import type { AuthGrant, SessionAuthAdapter } from '../src/account/auth-adapter';

class MemoryStorage {
  readonly values = new Map<string, string>();
  async read<T>(name: string, fallback: T): Promise<T> {
    const value = this.values.get(name);
    return value === undefined ? fallback : JSON.parse(value) as T;
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, JSON.stringify(value));
  }
  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}

class MemoryCredentials implements ProtectedCredentialStore {
  readonly values = new Map<string, string>();
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async remove(key: string): Promise<boolean> { return this.values.delete(key); }
  async listMetadata(): Promise<{ key: string; updatedAt: number }[]> {
    return [...this.values.keys()].map((key) => ({ key, updatedAt: 1 }));
  }
}

class MemoryDeviceRegistryAdapter implements DeviceRegistryAdapter {
  readonly records = new Map<string, RemoteDeviceRecord>();
  lastBegin?: BeginDeviceRegistrationInput;
  lastComplete?: CompleteDeviceRegistrationInput;
  challenge = 'device-proof-challenge';
  beginCalls = 0;

  async beginRegistration(input: BeginDeviceRegistrationInput) {
    this.beginCalls += 1;
    this.lastBegin = input;
    return {
      registrationId: 'registration-1',
      challenge: this.challenge,
      expiresAt: 10_000,
    };
  }

  async completeRegistration(input: CompleteDeviceRegistrationInput): Promise<RemoteDeviceRecord> {
    this.lastComplete = input;
    if (!this.lastBegin) throw new Error('begin ausente');
    const verified = crypto.verify(
      null,
      Buffer.from(this.challenge, 'utf8'),
      this.lastBegin.device.publicKey,
      Buffer.from(input.signature, 'base64'),
    );
    if (!verified) throw new Error('assinatura inválida');
    const record: RemoteDeviceRecord = {
      id: this.lastBegin.device.id,
      name: this.lastBegin.device.name,
      platform: this.lastBegin.device.platform,
      arch: this.lastBegin.device.arch,
      appVersion: this.lastBegin.device.appVersion,
      createdAt: 100,
      lastSeenAt: 100,
    };
    this.records.set(record.id, record);
    return record;
  }

  async list(): Promise<RemoteDeviceRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async rename(_accessToken: string, deviceId: string, name: string): Promise<RemoteDeviceRecord> {
    const current = this.records.get(deviceId);
    if (!current) throw new Error('dispositivo não registrado');
    const updated = { ...current, name };
    this.records.set(deviceId, updated);
    return updated;
  }

  async revoke(_accessToken: string, deviceId: string): Promise<void> {
    const current = this.records.get(deviceId);
    if (!current) return;
    this.records.set(deviceId, { ...current, revokedAt: 200 });
  }
}

function authGrant(deviceId: string): AuthGrant {
  return {
    account: {
      id: 'acct-1',
      primaryEmail: 'user@example.com',
      displayName: 'Gabriel',
      status: 'active',
      identities: [],
      createdAt: 1,
      updatedAt: 2,
    },
    session: {
      id: 'session-1',
      accountId: 'acct-1',
      deviceId,
      identityProvider: 'github',
      createdAt: 1,
      lastActivityAt: 2,
      accessExpiresAt: 50_000,
    },
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  };
}

async function setup() {
  const storage = new MemoryStorage();
  const credentials = new MemoryCredentials();
  const devices = new DeviceIdentityStore(
    storage as unknown as LocalStorage,
    credentials,
    {
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      defaultName: 'Este dispositivo',
      now: () => 100,
    },
  );
  const localDevice = await devices.getOrCreate();
  const auth: SessionAuthAdapter = {
    async refresh() { return authGrant(localDevice.id); },
    async revoke() { return; },
  };
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    auth,
  );
  await sessions.establish(authGrant(localDevice.id));
  const adapter = new MemoryDeviceRegistryAdapter();
  const registry = new DeviceRegistryRuntime(sessions, devices, adapter, () => 100);
  return { storage, credentials, devices, sessions, adapter, registry, localDevice };
}

test('DeviceRegistryRuntime proves private-key possession before registration', async () => {
  const { registry, adapter, localDevice } = await setup();

  const snapshot = await registry.ensureRegistered();

  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.currentDeviceId, localDevice.id);
  assert.equal(snapshot.devices.length, 1);
  assert.ok(adapter.lastBegin);
  assert.ok(adapter.lastComplete);
  assert.equal(adapter.lastBegin.accessToken, 'access-secret');
  assert.equal(adapter.lastComplete.accessToken, 'access-secret');
  assert.equal(adapter.lastComplete.deviceId, localDevice.id);
  assert.ok(adapter.lastComplete.signature.length > 40);
  assert.equal(JSON.stringify(snapshot).includes('access-secret'), false);
});

test('DeviceRegistryRuntime renames local and remote device consistently', async () => {
  const { registry, devices } = await setup();
  await registry.ensureRegistered();

  const snapshot = await registry.renameCurrent('Meu PC Principal');

  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.devices[0]?.name, 'Meu PC Principal');
  assert.equal((await devices.getOrCreate()).name, 'Meu PC Principal');
});

test('DeviceRegistryRuntime serializes onboarding rename with registration already in flight', async () => {
  const { registry, adapter, devices } = await setup();
  const originalComplete = adapter.completeRegistration.bind(adapter);
  let releaseRegistration: (() => void) | undefined;
  const registrationGate = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  adapter.completeRegistration = async (input: CompleteDeviceRegistrationInput) => {
    await registrationGate;
    return await originalComplete(input);
  };

  const registration = registry.ensureRegistered();
  const deadline = Date.now() + 1_000;
  while (!adapter.lastBegin && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(adapter.lastBegin, 'Registro remoto não iniciou.');

  const rename = registry.renameCurrent('PC do primeiro login');
  releaseRegistration?.();

  const [, renamed] = await Promise.all([registration, rename]);

  assert.equal(adapter.beginCalls, 1);
  assert.equal(renamed.state, 'ready');
  assert.equal(renamed.devices[0]?.name, 'PC do primeiro login');
  assert.equal((await devices.getOrCreate()).name, 'PC do primeiro login');
});

test('DeviceRegistryRuntime revokes remote devices without deleting local identity', async () => {
  const { registry, devices, localDevice } = await setup();
  await registry.ensureRegistered();

  const snapshot = await registry.revoke(localDevice.id);

  assert.equal(snapshot.devices[0]?.revokedAt, 200);
  assert.equal((await devices.getOrCreate()).id, localDevice.id);
});

test('DeviceRegistryRuntime refuses registration without authenticated access token', async () => {
  const { storage, credentials, devices, sessions, adapter } = await setup();
  await sessions.logout();

  const registry = new DeviceRegistryRuntime(sessions, devices, adapter, () => 100);
  const snapshot = await registry.ensureRegistered();

  assert.equal(snapshot.state, 'unavailable');
  assert.equal(adapter.lastBegin, undefined);
  assert.equal(storage.values.has('device-identity.json'), true);
  assert.equal(credentials.values.has('account.device.private-key'), true);
});

test('DeviceRegistryRuntime rejects expired registration challenges', async () => {
  const { registry, adapter } = await setup();
  adapter.beginRegistration = async (input: BeginDeviceRegistrationInput) => {
    adapter.lastBegin = input;
    return { registrationId: 'registration-1', challenge: 'challenge', expiresAt: 99 };
  };

  const snapshot = await registry.ensureRegistered();

  assert.equal(snapshot.state, 'error');
  assert.match(snapshot.lastError ?? '', /expirado/);
  assert.equal(adapter.lastComplete, undefined);
});
