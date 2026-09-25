import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { LocalStorage } from '../src/core/storage';
import type { ProtectedCredentialStore } from '../src/account/protected-credential-store';
import { DeviceIdentityStore } from '../src/account/device-identity';
import { AccountSessionRuntime } from '../src/account/account-session-runtime';
import { AuthAdapterError, type AuthGrant, type SessionAuthAdapter } from '../src/account/auth-adapter';
import type { AccountProfile, AccountSession } from '../src/account/types';

class MemoryStorage {
  readonly values = new Map<string, string>();
  failAccountSessionWrites = false;

  async read<T>(name: string, fallback: T): Promise<T> {
    const value = this.values.get(name);
    return value === undefined ? fallback : JSON.parse(value) as T;
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (this.failAccountSessionWrites && name === 'account-session.json') {
      throw new Error('Falha simulada ao persistir sessão.');
    }
    this.values.set(name, JSON.stringify(value));
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}

class MemoryCredentials implements ProtectedCredentialStore {
  readonly values = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async remove(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async listMetadata(): Promise<{ key: string; updatedAt: number }[]> {
    return Array.from(this.values.keys()).map((key) => ({ key, updatedAt: 1 }));
  }
}

function profile(): AccountProfile {
  return {
    id: 'acct-1',
    primaryEmail: 'user@example.com',
    displayName: 'Gabriel',
    username: 'gabriel-7f2a',
    status: 'active',
    identities: [{
      id: 'identity-1',
      provider: 'github',
      providerAccountId: 'gh-1',
      email: 'user@example.com',
      linkedAt: 10,
    }],
    createdAt: 10,
    updatedAt: 20,
  };
}

function session(deviceId: string): AccountSession {
  return {
    id: 'session-1',
    accountId: 'acct-1',
    deviceId,
    identityProvider: 'github',
    createdAt: 10,
    lastActivityAt: 20,
    accessExpiresAt: 30_000,
  };
}

test('DeviceIdentityStore creates a stable asymmetric identity and signs challenges', async () => {
  const storage = new MemoryStorage();
  const credentials = new MemoryCredentials();
  let now = 100;

  const devices = new DeviceIdentityStore(
    storage as unknown as LocalStorage,
    credentials,
    {
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      defaultName: 'Este dispositivo',
      now: () => now,
    },
  );

  const first = await devices.getOrCreate();
  now = 200;
  const second = await devices.getOrCreate();

  assert.equal(first.id, second.id);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(first.name, 'Este dispositivo');
  assert.equal(second.lastSeenAt, 200);
  assert.equal(second.platform, 'win32');
  assert.equal(second.arch, 'x64');

  const privateKey = credentials.values.get('account.device.private-key');
  assert.ok(privateKey);
  assert.ok(!storage.values.get('device-identity.json')?.includes('PRIVATE KEY'));

  const challenge = 'relay-challenge-123';
  const signature = await devices.signChallenge(challenge);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(challenge, 'utf8'),
      first.publicKey,
      Buffer.from(signature, 'base64'),
    ),
    true,
  );
});

test('AccountSessionRuntime keeps access token in memory and refresh token outside public state', async () => {
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
  const device = await devices.getOrCreate();

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new Error('refresh não deveria ser chamado neste teste');
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  const grant: AuthGrant = {
    account: profile(),
    session: session(device.id),
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  };

  const snapshot = await runtime.establish(grant);
  assert.equal(snapshot.state, 'authenticated');
  assert.equal(snapshot.device.name, 'Gabriel');
  assert.equal(runtime.getAccessToken(), 'access-secret');
  assert.equal(credentials.values.get('account.session.refresh-token'), 'refresh-secret');

  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('access-secret'));
  assert.ok(!serialized.includes('refresh-secret'));

  const persisted = storage.values.get('account-session.json') ?? '';
  assert.ok(!persisted.includes('access-secret'));
  assert.ok(!persisted.includes('refresh-secret'));
});

test('AccountSessionRuntime restores cached account offline without exposing a token', async () => {
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
  const device = await devices.getOrCreate();

  await storage.write('account-session.json', {
    account: profile(),
    session: session(device.id),
  });
  await credentials.set('account.session.refresh-token', 'refresh-secret');

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new AuthAdapterError('offline', 'Sem internet.');
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  const snapshot = await runtime.hydrate();
  assert.equal(snapshot.state, 'offline');
  assert.equal(snapshot.account?.displayName, 'Gabriel');
  assert.equal(runtime.getAccessToken(), null);
  assert.ok(!JSON.stringify(snapshot).includes('refresh-secret'));
});

test('AccountSessionRuntime clears revoked sessions and local secrets', async () => {
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
  const device = await devices.getOrCreate();

  await storage.write('account-session.json', {
    account: profile(),
    session: session(device.id),
  });
  await credentials.set('account.session.refresh-token', 'refresh-secret');

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new AuthAdapterError('revoked', 'Sessão revogada.');
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  const snapshot = await runtime.hydrate();
  assert.equal(snapshot.state, 'revoked');
  assert.equal(credentials.values.has('account.session.refresh-token'), false);
  assert.equal(storage.values.has('account-session.json'), false);
});


test('AccountSessionRuntime subscriptions expose only sanitized snapshots', async () => {
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
  const device = await devices.getOrCreate();

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new Error('refresh não deveria ser chamado neste teste');
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  const seen: string[] = [];
  const unsubscribe = runtime.subscribe((snapshot) => {
    seen.push(JSON.stringify(snapshot));
  });

  await runtime.establish({
    account: profile(),
    session: session(device.id),
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  });
  await runtime.renameDevice('Meu PC');
  unsubscribe();

  assert.equal(seen.length, 2);
  assert.ok(seen.every((serialized) => !serialized.includes('access-secret')));
  assert.ok(seen.every((serialized) => !serialized.includes('refresh-secret')));
  assert.ok(seen[1]?.includes('Meu PC'));
});


test('AccountSessionRuntime logout clears local credentials even when remote revoke fails', async () => {
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
  const device = await devices.getOrCreate();

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new Error('refresh não deveria ser chamado neste teste');
    },
    async revoke(): Promise<void> {
      throw new AuthAdapterError('offline', 'Servidor indisponível.');
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  await runtime.establish({
    account: profile(),
    session: session(device.id),
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  });

  const snapshot = await runtime.logout();
  assert.equal(snapshot.state, 'signed_out');
  assert.equal(runtime.getAccessToken(), null);
  assert.equal(credentials.values.has('account.session.refresh-token'), false);
  assert.equal(storage.values.has('account-session.json'), false);
});

test('AccountSessionRuntime rejects grants bound to another device', async () => {
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

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new Error('refresh não deveria ser chamado neste teste');
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  await assert.rejects(
    runtime.establish({
      account: profile(),
      session: session('other-device'),
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
    }),
    /outro dispositivo/,
  );

  assert.equal(credentials.values.has('account.session.refresh-token'), false);
  assert.equal(storage.values.has('account-session.json'), false);
});


test('DeviceIdentityStore falls back to ephemeral identity when protected storage is unavailable', async () => {
  const storage = new MemoryStorage();
  const credentials = new MemoryCredentials();
  credentials.set = async (): Promise<void> => {
    throw new Error('Sistema de armazenamento seguro indisponível.');
  };

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

  const first = await devices.getOrCreate();
  const second = await devices.getOrCreate();

  assert.equal(first.credentialPersistence, 'ephemeral');
  assert.equal(second.id, first.id);
  assert.equal(storage.values.has('device-identity.json'), false);

  const challenge = 'ephemeral-challenge';
  const signature = await devices.signChallenge(challenge);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(challenge, 'utf8'),
      first.publicKey,
      Buffer.from(signature, 'base64'),
    ),
    true,
  );
});


test('AccountSessionRuntime fails closed when session metadata persistence fails after refresh-token storage', async () => {
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
  const device = await devices.getOrCreate();
  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new Error('refresh não deveria ser chamado neste teste');
    },
    async revoke(): Promise<void> {
      return;
    },
  };
  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  storage.failAccountSessionWrites = true;
  await assert.rejects(
    runtime.establish({
      account: profile(),
      session: session(device.id),
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
    }),
    /Falha simulada/,
  );

  assert.equal(runtime.snapshot().state, 'signed_out');
  assert.equal(runtime.getAccessToken(), null);
  assert.equal(credentials.values.has('account.session.refresh-token'), false);
  assert.equal(storage.values.has('account-session.json'), false);
});


test('AccountSessionRuntime refreshSession rotates credentials and updates the live session', async () => {
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
  const device = await devices.getOrCreate();
  let refreshCalls = 0;

  const adapter: SessionAuthAdapter = {
    async refresh(input): Promise<AuthGrant> {
      refreshCalls += 1;
      assert.equal(input.refreshToken, 'refresh-old');
      assert.equal(input.deviceId, device.id);
      return {
        account: profile(),
        session: { ...session(device.id), id: 'session-2', accessExpiresAt: 90_000 },
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
      };
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  await runtime.establish({
    account: profile(),
    session: session(device.id),
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
  });

  const refreshed = await runtime.refreshSession();

  assert.equal(refreshCalls, 1);
  assert.equal(refreshed.state, 'authenticated');
  assert.equal(refreshed.session?.id, 'session-2');
  assert.equal(runtime.getAccessToken(), 'access-new');
  assert.equal(credentials.values.get('account.session.refresh-token'), 'refresh-new');
});

test('AccountSessionRuntime refreshSession preserves cached account while temporarily offline', async () => {
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
  const device = await devices.getOrCreate();

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      throw new AuthAdapterError('offline', 'Sem conexão.');
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );

  await runtime.establish({
    account: profile(),
    session: session(device.id),
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
  });

  const refreshed = await runtime.refreshSession();

  assert.equal(refreshed.state, 'offline');
  assert.equal(refreshed.account?.id, 'acct-1');
  assert.equal(refreshed.session?.id, 'session-1');
  assert.equal(runtime.getAccessToken(), null);
  assert.equal(credentials.values.get('account.session.refresh-token'), 'refresh-old');
});


test('AccountSessionRuntime deduplicates concurrent refreshes so a rotating token is consumed once', async () => {
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
  const device = await devices.getOrCreate();
  let refreshCalls = 0;
  let releaseRefresh: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  const adapter: SessionAuthAdapter = {
    async refresh(input): Promise<AuthGrant> {
      refreshCalls += 1;
      assert.equal(input.refreshToken, 'refresh-old');
      await gate;
      return {
        account: profile(),
        session: { ...session(device.id), id: 'session-2', accessExpiresAt: 90_000 },
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
      };
    },
    async revoke(): Promise<void> {
      return;
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  await runtime.establish({
    account: profile(),
    session: session(device.id),
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
  });

  const first = runtime.refreshSession();
  const second = runtime.refreshSession();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);

  releaseRefresh?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.state, 'authenticated');
  assert.equal(secondResult.state, 'authenticated');
  assert.equal(firstResult.session?.id, 'session-2');
  assert.equal(secondResult.session?.id, 'session-2');
  assert.equal(credentials.values.get('account.session.refresh-token'), 'refresh-new');
});

test('AccountSessionRuntime logout waits for an in-flight refresh and revokes the rotated session', async () => {
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
  const device = await devices.getOrCreate();
  let releaseRefresh: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const revoked: Array<{ sessionId: string; refreshToken?: string }> = [];

  const adapter: SessionAuthAdapter = {
    async refresh(): Promise<AuthGrant> {
      await gate;
      return {
        account: profile(),
        session: { ...session(device.id), id: 'session-2', accessExpiresAt: 90_000 },
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
      };
    },
    async revoke(input): Promise<void> {
      revoked.push({ sessionId: input.sessionId, refreshToken: input.refreshToken });
    },
  };

  const runtime = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  await runtime.establish({
    account: profile(),
    session: session(device.id),
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
  });

  const refresh = runtime.refreshSession();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const logout = runtime.logout();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(revoked.length, 0);

  releaseRefresh?.();
  await refresh;
  const signedOut = await logout;

  assert.equal(signedOut.state, 'signed_out');
  assert.equal(runtime.getAccessToken(), null);
  assert.deepEqual(revoked, [{ sessionId: 'session-2', refreshToken: 'refresh-new' }]);
  assert.equal(credentials.values.has('account.session.refresh-token'), false);
  assert.equal(storage.values.has('account-session.json'), false);
});
