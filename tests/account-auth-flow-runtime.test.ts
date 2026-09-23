import test from 'node:test';
import assert from 'node:assert/strict';
import type { LocalStorage } from '../src/core/storage';
import type { ProtectedCredentialStore } from '../src/account/protected-credential-store';
import { DeviceIdentityStore } from '../src/account/device-identity';
import { AccountSessionRuntime } from '../src/account/account-session-runtime';
import { AccountAuthFlowRuntime } from '../src/account/account-auth-flow-runtime';
import type {
  AuthAdapter,
  AuthGrant,
  AuthMethod,
  BeginMagicLinkInput,
  BeginOAuthInput,
  BeginPasskeyInput,
  CompleteMagicLinkInput,
  CompleteOAuthInput,
  CompletePasskeyInput,
  BeginHostedInput,
  CompleteHostedInput,
  OAuthProvider,
  RefreshSessionInput,
  RevokeSessionInput,
} from '../src/account/auth-adapter';
import type { AccountProfile, AccountSession } from '../src/account/types';

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

class FakeAuthAdapter implements AuthAdapter {
  lastOAuthBegin?: BeginOAuthInput;
  lastOAuthComplete?: CompleteOAuthInput;
  lastMagicBegin?: BeginMagicLinkInput;
  lastMagicComplete?: CompleteMagicLinkInput;
  lastPasskeyBegin?: BeginPasskeyInput;
  lastPasskeyComplete?: CompletePasskeyInput;
  lastHostedBegin?: BeginHostedInput;
  lastHostedComplete?: CompleteHostedInput;

  constructor(private readonly grantFactory: (deviceId: string) => AuthGrant) {}

  async configuration(): Promise<{ methods: AuthMethod[] }> {
    return { methods: ['magic_link', 'github', 'google', 'microsoft', 'passkey'] };
  }

  async refresh(input: RefreshSessionInput): Promise<AuthGrant> {
    return this.grantFactory(input.deviceId);
  }

  async revoke(_input: RevokeSessionInput): Promise<void> {
    return;
  }

  async beginOAuth(input: BeginOAuthInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    this.lastOAuthBegin = input;
    return {
      authorizationUrl: 'https://auth.example.test/start',
      flowId: 'oauth-flow',
      expiresAt: 10_000,
    };
  }

  async completeOAuth(input: CompleteOAuthInput): Promise<AuthGrant> {
    this.lastOAuthComplete = input;
    return this.grantFactory(input.deviceId);
  }

  async beginMagicLink(input: BeginMagicLinkInput): Promise<{ flowId: string; expiresAt: number }> {
    this.lastMagicBegin = input;
    return { flowId: 'magic-flow', expiresAt: 10_000 };
  }

  async completeMagicLink(input: CompleteMagicLinkInput): Promise<AuthGrant> {
    this.lastMagicComplete = input;
    return this.grantFactory(input.deviceId);
  }

  async beginPasskey(input: BeginPasskeyInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    this.lastPasskeyBegin = input;
    return {
      authorizationUrl: 'https://auth.example.test/passkey',
      flowId: 'passkey-flow',
      expiresAt: 10_000,
    };
  }

  async completePasskey(input: CompletePasskeyInput): Promise<AuthGrant> {
    this.lastPasskeyComplete = input;
    return this.grantFactory(input.deviceId);
  }

  async beginHosted(input: BeginHostedInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    this.lastHostedBegin = input;
    return {
      authorizationUrl: 'https://auth.example.test/hosted',
      flowId: 'hosted-flow',
      expiresAt: 10_000,
    };
  }

  async completeHosted(input: CompleteHostedInput): Promise<AuthGrant> {
    this.lastHostedComplete = input;
    return this.grantFactory(input.deviceId);
  }
}

function profile(): AccountProfile {
  return {
    id: 'acct-1',
    primaryEmail: 'user@example.com',
    displayName: 'Gabriel',
    status: 'active',
    identities: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function grant(deviceId: string, provider: OAuthProvider | 'magic_link' | 'passkey' | 'descope' = 'github'): AuthGrant {
  const session: AccountSession = {
    id: 'session-1',
    accountId: 'acct-1',
    deviceId,
    identityProvider: provider,
    createdAt: 1,
    lastActivityAt: 2,
    accessExpiresAt: 5_000,
  };
  return {
    account: profile(),
    session,
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  };
}

function setup(now = 100) {
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
      now: () => now,
    },
  );
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId));
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const flows = new AccountAuthFlowRuntime(adapter, sessions, devices, () => now, credentials);
  return { storage, credentials, devices, adapter, sessions, flows };
}

test('OAuth flow keeps state nonce and verifier out of public snapshots', async () => {
  const { adapter, flows, sessions } = setup();

  const started = await flows.beginOAuth('github');
  assert.equal(started.snapshot.status, 'waiting_browser');
  assert.equal(started.snapshot.provider, 'github');
  assert.equal(started.authorizationUrl, 'https://auth.example.test/start');

  const publicJson = JSON.stringify(started.snapshot);
  assert.ok(adapter.lastOAuthBegin);
  assert.ok(!publicJson.includes(adapter.lastOAuthBegin.state));
  assert.ok(!publicJson.includes(adapter.lastOAuthBegin.nonce));
  assert.ok(!publicJson.includes(adapter.lastOAuthBegin.codeChallenge));

  const completed = await flows.completeOAuth({
    flowId: 'oauth-flow',
    code: 'oauth-code',
    state: adapter.lastOAuthBegin.state,
  });

  assert.equal(completed.status, 'authenticated');
  assert.equal(sessions.snapshot().state, 'authenticated');
  assert.ok(adapter.lastOAuthComplete);
  assert.equal(adapter.lastOAuthComplete.codeVerifier.length > 40, true);
  assert.equal(adapter.lastOAuthComplete.nonce, adapter.lastOAuthBegin.nonce);
});

test('OAuth state mismatch is rejected before adapter completion', async () => {
  const { adapter, flows } = setup();
  await flows.beginOAuth('google');

  const result = await flows.completeOAuth({
    flowId: 'oauth-flow',
    code: 'oauth-code',
    state: 'wrong-state',
  });

  assert.equal(result.status, 'error');
  assert.match(result.lastError ?? '', /Estado OAuth inválido/);
  assert.equal(adapter.lastOAuthComplete, undefined);
});

test('Magic Link normalizes email and only exposes a masked hint', async () => {
  const { adapter, flows } = setup();

  const started = await flows.beginMagicLink('  User@Example.COM ');
  assert.equal(started.status, 'waiting_magic_link');
  assert.equal(started.emailHint, 'us**@example.com');
  assert.equal(adapter.lastMagicBegin?.email, 'user@example.com');

  assert.ok(adapter.lastMagicBegin);
  const publicJson = JSON.stringify(started);
  assert.ok(!publicJson.includes(adapter.lastMagicBegin.state));
  assert.ok(!publicJson.includes(adapter.lastMagicBegin.codeChallenge));

  const completed = await flows.completeMagicLink({
    flowId: 'magic-flow',
    token: 'magic-token',
    state: adapter.lastMagicBegin.state,
  });
  assert.equal(completed.status, 'authenticated');
  assert.equal(adapter.lastMagicComplete?.token, 'magic-token');
  assert.equal(adapter.lastMagicComplete?.state, adapter.lastMagicBegin.state);
  assert.equal(adapter.lastMagicComplete?.codeVerifier.length > 40, true);
  assert.ok(!JSON.stringify(completed).includes('magic-token'));
});

test('Passkey flow keeps PKCE material private and completes through browser callback', async () => {
  const { adapter, flows, sessions } = setup();

  const started = await flows.beginPasskey();
  assert.equal(started.snapshot.status, 'waiting_browser');
  assert.equal(started.snapshot.method, 'passkey');
  assert.equal(started.authorizationUrl, 'https://auth.example.test/passkey');
  assert.ok(adapter.lastPasskeyBegin);

  const publicJson = JSON.stringify(started.snapshot);
  assert.ok(!publicJson.includes(adapter.lastPasskeyBegin.state));
  assert.ok(!publicJson.includes(adapter.lastPasskeyBegin.nonce));
  assert.ok(!publicJson.includes(adapter.lastPasskeyBegin.codeChallenge));

  const completed = await flows.completePasskey({
    flowId: 'passkey-flow',
    code: 'passkey-code',
    state: adapter.lastPasskeyBegin.state,
  });

  assert.equal(completed.status, 'authenticated');
  assert.equal(adapter.lastPasskeyComplete?.code, 'passkey-code');
  assert.equal(adapter.lastPasskeyComplete?.nonce, adapter.lastPasskeyBegin.nonce);
  assert.equal(adapter.lastPasskeyComplete?.codeVerifier.length > 40, true);
  assert.equal(sessions.snapshot().state, 'authenticated');
});

test('Hosted flow keeps PKCE state and nonce private and completes once', async () => {
  const { adapter, flows, sessions } = setup();

  const started = await flows.beginHosted();
  assert.equal(started.snapshot.status, 'waiting_browser');
  assert.equal(started.snapshot.method, 'hosted');
  assert.equal(started.authorizationUrl, 'https://auth.example.test/hosted');
  assert.ok(adapter.lastHostedBegin);

  const publicJson = JSON.stringify(started.snapshot);
  assert.ok(!publicJson.includes(adapter.lastHostedBegin.state));
  assert.ok(!publicJson.includes(adapter.lastHostedBegin.nonce));
  assert.ok(!publicJson.includes(adapter.lastHostedBegin.codeChallenge));

  const completed = await flows.completeHosted({
    code: 'hosted-code',
    state: adapter.lastHostedBegin.state,
  });

  assert.equal(completed.status, 'authenticated');
  assert.equal(sessions.snapshot().state, 'authenticated');
  assert.equal(adapter.lastHostedComplete?.code, 'hosted-code');
  assert.equal(adapter.lastHostedComplete?.nonce, adapter.lastHostedBegin.nonce);
  assert.equal(adapter.lastHostedComplete?.codeVerifier.length > 40, true);
});

test('Hosted flow survives an app restart with PKCE material in protected storage', async () => {
  const now = 100;
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
      now: () => now,
    },
  );
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId, 'descope'));
  const firstSessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const firstRuntime = new AccountAuthFlowRuntime(
    adapter,
    firstSessions,
    devices,
    () => now,
    credentials,
  );

  await firstRuntime.beginHosted();
  assert.ok(adapter.lastHostedBegin);

  const secondSessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  await secondSessions.hydrate();
  const secondRuntime = new AccountAuthFlowRuntime(
    adapter,
    secondSessions,
    devices,
    () => now,
    credentials,
  );

  const completed = await secondRuntime.completeHosted({
    code: 'hosted-code-after-restart',
    state: adapter.lastHostedBegin.state,
  });

  assert.equal(completed.status, 'authenticated');
  assert.equal(secondSessions.snapshot().state, 'authenticated');
  assert.equal(adapter.lastHostedComplete?.code, 'hosted-code-after-restart');
  assert.equal(adapter.lastHostedComplete?.codeVerifier.length > 40, true);
  assert.equal(await credentials.get('account.auth.pending-hosted'), null);
});

test('Hosted provider cancellation validates state and clears protected pending state', async () => {
  const now = 100;
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
      now: () => now,
    },
  );
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId, 'descope'));
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const runtime = new AccountAuthFlowRuntime(adapter, sessions, devices, () => now, credentials);

  await runtime.beginHosted();
  assert.ok(adapter.lastHostedBegin);
  const cancelled = await runtime.failHostedCallback({
    error: 'access_denied',
    state: adapter.lastHostedBegin.state,
  });
  assert.equal(cancelled.status, 'error');
  assert.equal(cancelled.lastError, 'Autenticação cancelada.');
  assert.equal(await credentials.get('account.auth.pending-hosted'), null);
});

test('Cancelling hosted auth clears persisted PKCE material and rejects a later callback', async () => {
  const now = 100;
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
      now: () => now,
    },
  );
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId, 'descope'));
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const runtime = new AccountAuthFlowRuntime(adapter, sessions, devices, () => now, credentials);

  await runtime.beginHosted();
  assert.ok(adapter.lastHostedBegin);
  assert.ok(await credentials.get('account.auth.pending-hosted'));

  const cancelled = await runtime.cancel();
  assert.equal(cancelled.status, 'idle');
  assert.equal(await credentials.get('account.auth.pending-hosted'), null);

  await assert.rejects(
    runtime.completeHosted({
      code: 'late-code',
      state: adapter.lastHostedBegin.state,
    }),
    /inválido ou expirado/,
  );
});

test('Forged hosted callback state cannot cancel the valid protected transaction', async () => {
  const now = 100;
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
      now: () => now,
    },
  );
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId, 'descope'));
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const runtime = new AccountAuthFlowRuntime(adapter, sessions, devices, () => now, credentials);

  await runtime.beginHosted();
  assert.ok(adapter.lastHostedBegin);

  const rejected = await runtime.failHostedCallback({
    error: 'access_denied',
    state: 'forged-state',
  });
  assert.equal(rejected.status, 'error');
  assert.match(rejected.lastError ?? '', /Estado de autenticação inválido/);
  assert.ok(await credentials.get('account.auth.pending-hosted'));

  const completed = await runtime.completeHosted({
    code: 'real-code',
    state: adapter.lastHostedBegin.state,
  });
  assert.equal(completed.status, 'authenticated');
  assert.equal(await credentials.get('account.auth.pending-hosted'), null);
});

test('Hosted state mismatch is rejected before token exchange', async () => {
  const { adapter, flows } = setup();
  await flows.beginHosted();

  const result = await flows.completeHosted({
    code: 'hosted-code',
    state: 'wrong-state',
  });

  assert.equal(result.status, 'error');
  assert.match(result.lastError ?? '', /Estado de autenticação inválido/);
  assert.equal(adapter.lastHostedComplete, undefined);
});

test('Auth flow refuses persistent login when device secure storage is unavailable', async () => {
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
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId));
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const flows = new AccountAuthFlowRuntime(adapter, sessions, devices, () => 100);

  await assert.rejects(
    flows.beginMagicLink('user@example.com'),
    /Armazenamento seguro do sistema indisponível/,
  );
  assert.equal(adapter.lastMagicBegin, undefined);
});

test('Expired auth flow cannot be completed', async () => {
  let now = 100;
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
      now: () => now,
    },
  );
  const adapter = new FakeAuthAdapter((deviceId) => grant(deviceId));
  adapter.beginMagicLink = async (input: BeginMagicLinkInput) => {
    adapter.lastMagicBegin = input;
    return { flowId: 'magic-flow', expiresAt: 150 };
  };
  const sessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  const flows = new AccountAuthFlowRuntime(adapter, sessions, devices, () => now);

  await flows.beginMagicLink('user@example.com');
  now = 200;

  await assert.rejects(
    flows.completeMagicLink({
      flowId: 'magic-flow',
      token: 'token',
      state: adapter.lastMagicBegin?.state ?? 'missing-state',
    }),
    /expirado/,
  );
  assert.equal(flows.snapshot().status, 'error');
});


test('native OAuth survives app restart and preserves the valid transaction after a forged callback', async () => {
  const { storage, credentials, devices, adapter, sessions, flows } = setup();
  await sessions.hydrate();
  await flows.beginOAuth('github');
  assert.ok(adapter.lastOAuthBegin);
  assert.ok(await credentials.get('account.auth.pending-oauth'));

  const forged = await flows.completeOAuth({
    flowId: 'oauth-flow',
    code: 'forged-code',
    state: 'forged-state',
  });
  assert.equal(forged.status, 'error');
  assert.match(forged.lastError ?? '', /Estado OAuth inválido/);
  assert.ok(await credentials.get('account.auth.pending-oauth'));
  assert.equal(adapter.lastOAuthComplete, undefined);

  const restoredSessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  await restoredSessions.hydrate();
  const restored = new AccountAuthFlowRuntime(
    adapter,
    restoredSessions,
    devices,
    () => 100,
    credentials,
  );
  const completed = await restored.completeOAuth({
    flowId: 'oauth-flow',
    code: 'real-code',
    state: adapter.lastOAuthBegin.state,
  });

  assert.equal(completed.status, 'authenticated');
  assert.equal(adapter.lastOAuthComplete?.code, 'real-code');
  assert.equal(restoredSessions.snapshot().state, 'authenticated');
  assert.equal(await credentials.get('account.auth.pending-oauth'), null);
  assert.equal(sessions.snapshot().state, 'signed_out');
});

test('Magic Link survives app restart and consumes protected pending state exactly once', async () => {
  const { storage, credentials, devices, adapter, flows } = setup();
  await flows.beginMagicLink('user@example.com');
  assert.ok(adapter.lastMagicBegin);
  assert.ok(await credentials.get('account.auth.pending-magic-link'));

  const restoredSessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  await restoredSessions.hydrate();
  const restored = new AccountAuthFlowRuntime(
    adapter,
    restoredSessions,
    devices,
    () => 100,
    credentials,
  );
  const completed = await restored.completeMagicLink({
    flowId: 'magic-flow',
    token: 'one-time-token',
    state: adapter.lastMagicBegin.state,
  });

  assert.equal(completed.status, 'authenticated');
  assert.equal(adapter.lastMagicComplete?.token, 'one-time-token');
  assert.equal(await credentials.get('account.auth.pending-magic-link'), null);

  await assert.rejects(
    new AccountAuthFlowRuntime(adapter, restoredSessions, devices, () => 100, credentials)
      .completeMagicLink({
        flowId: 'magic-flow',
        token: 'replay-token',
        state: adapter.lastMagicBegin.state,
      }),
    /Fluxo de Magic Link inválido/,
  );
});

test('Passkey PKCE transaction survives app restart without exposing verifier', async () => {
  const { storage, credentials, devices, adapter, flows } = setup();
  const started = await flows.beginPasskey();
  assert.ok(adapter.lastPasskeyBegin);
  const persisted = await credentials.get('account.auth.pending-passkey');
  assert.ok(persisted);
  assert.ok(!JSON.stringify(started.snapshot).includes(adapter.lastPasskeyBegin.codeChallenge));

  const restoredSessions = new AccountSessionRuntime(
    storage as unknown as LocalStorage,
    credentials,
    devices,
    adapter,
  );
  await restoredSessions.hydrate();
  const restored = new AccountAuthFlowRuntime(
    adapter,
    restoredSessions,
    devices,
    () => 100,
    credentials,
  );

  const completed = await restored.completePasskey({
    code: 'passkey-code',
    state: adapter.lastPasskeyBegin.state,
  });
  assert.equal(completed.status, 'authenticated');
  assert.equal(adapter.lastPasskeyComplete?.codeVerifier.length > 40, true);
  assert.equal(await credentials.get('account.auth.pending-passkey'), null);
});


test('valid native OAuth cancellation clears protected state but forged cancellation does not', async () => {
  const { credentials, adapter, flows } = setup();
  await flows.beginOAuth('microsoft');
  assert.ok(adapter.lastOAuthBegin);

  const forged = await flows.failOAuthCallback({
    flowId: 'oauth-flow',
    error: 'access_denied',
    state: 'forged-state',
  });
  assert.equal(forged.status, 'error');
  assert.match(forged.lastError ?? '', /Estado OAuth inválido/);
  assert.ok(await credentials.get('account.auth.pending-oauth'));

  const cancelled = await flows.failOAuthCallback({
    flowId: 'oauth-flow',
    error: 'access_denied',
    state: adapter.lastOAuthBegin.state,
  });
  assert.equal(cancelled.status, 'error');
  assert.equal(cancelled.lastError, 'Autenticação cancelada.');
  assert.equal(await credentials.get('account.auth.pending-oauth'), null);
});

test('valid passkey cancellation clears protected PKCE material', async () => {
  const { credentials, adapter, flows } = setup();
  await flows.beginPasskey();
  assert.ok(adapter.lastPasskeyBegin);
  assert.ok(await credentials.get('account.auth.pending-passkey'));

  const cancelled = await flows.failPasskeyCallback({
    error: 'access_denied',
    state: adapter.lastPasskeyBegin.state,
  });
  assert.equal(cancelled.status, 'error');
  assert.equal(cancelled.lastError, 'Autenticação cancelada.');
  assert.equal(await credentials.get('account.auth.pending-passkey'), null);
});

test('reset cleanup is serialized before a new protected OAuth transaction is persisted', async () => {
  const { credentials, adapter, flows } = setup();
  let releaseCleanup: (() => void) | undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const originalRemove = credentials.remove.bind(credentials);
  let blockCleanup = true;
  credentials.remove = async (key: string): Promise<boolean> => {
    if (blockCleanup) await cleanupGate;
    return await originalRemove(key);
  };

  flows.reset();
  const startedPromise = flows.beginOAuth('github');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(adapter.lastOAuthBegin, undefined);

  blockCleanup = false;
  releaseCleanup?.();
  const started = await startedPromise;

  assert.equal(started.snapshot.status, 'waiting_browser');
  assert.ok(adapter.lastOAuthBegin);
  assert.ok(await credentials.get('account.auth.pending-oauth'));
});

test('expired protected OAuth transaction is removed during restart restoration', async () => {
  const { credentials, flows } = setup(200);
  await credentials.set('account.auth.pending-oauth', JSON.stringify({
    flowId: 'oauth-flow',
    provider: 'github',
    state: 'state-12345678901234567890',
    nonce: 'nonce-12345678901234567890',
    codeVerifier: 'verifier-12345678901234567890123456789012345678901234567890',
    expiresAt: 150,
  }));

  await assert.rejects(
    flows.completeOAuth({
      flowId: 'oauth-flow',
      code: 'late-code',
      state: 'state-12345678901234567890',
    }),
    /Fluxo OAuth inválido/,
  );
  assert.equal(await credentials.get('account.auth.pending-oauth'), null);
});

