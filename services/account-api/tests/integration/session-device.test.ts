import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountApiEnvironment } from '../../src/env.js';
import { Database } from '../../src/db.js';
import { DesktopSessionService } from '../../src/desktop-session.js';
import { DesktopAuthFlowService } from '../../src/desktop-auth-flow.js';
import { DeviceRegistryService } from '../../src/device-registry.js';
import type { DeviceAccessVerifier } from '../../src/descope-session-verifier.js';

function environment(): AccountApiEnvironment {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests.');
  return {
    publicUrl: 'https://accounts.example.test',
    port: 8080,
    databaseUrl,
    betterAuthSecret: 'better-auth-integration-secret-000000000000',
    accessTokenSecret: 'desktop-access-integration-secret-000000000',
    passkeyRpId: 'accounts.example.test',
    passkeyRpName: 'Auto CodeZ',
  };
}

async function migrateDesktopSchema(database: Database): Promise<void> {
  const directory = path.join(process.cwd(), 'migrations');
  const migrations = (await fs.readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  assert.ok(migrations.length > 0, 'Desktop migrations are missing.');
  for (const name of migrations) {
    await database.pool.query(await fs.readFile(path.join(directory, name), 'utf8'));
  }
}

async function reset(database: Database): Promise<void> {
  await database.pool.query(`
    TRUNCATE TABLE
      device_registration,
      device_registry,
      desktop_refresh_token,
      desktop_session,
      desktop_identity,
      desktop_auth_flow,
      desktop_account
    RESTART IDENTITY CASCADE
  `);
}

test('refresh rotation revokes the whole session on token replay', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    let now = 1_800_000_000_000;
    const sessions = new DesktopSessionService(database, env, () => now);
    const first = await sessions.issue({
      user: {
        id: 'user-refresh-1',
        email: 'refresh@example.com',
        name: 'Refresh User',
      },
      provider: 'github',
      deviceId: 'device-refresh-1',
    });

    now += 1_000;
    const rotated = await sessions.refresh(first.refreshToken, 'device-refresh-1');
    assert.notEqual(rotated.refreshToken, first.refreshToken);

    now += 1_000;
    await assert.rejects(
      sessions.refresh(first.refreshToken, 'device-refresh-1'),
      /invalid_grant/,
    );

    now += 1_000;
    await assert.rejects(
      sessions.refresh(rotated.refreshToken, 'device-refresh-1'),
      /invalid_grant/,
    );

    const rows = await database.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM desktop_session WHERE id = $1',
      [first.session.id],
    );
    assert.equal(rows[0]?.revoked, true);
  } finally {
    await database.close();
  }
});

test('Device Registry requires proof of Ed25519 private-key possession and revocation kills sessions', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    let now = 1_800_000_000_000;
    const sessions = new DesktopSessionService(database, env, () => now);
    const registry = new DeviceRegistryService(database, env, () => now);

    const grant = await sessions.issue({
      user: {
        id: 'user-device-1',
        email: 'device@example.com',
        name: 'Device User',
      },
      provider: 'google',
      deviceId: 'device-registry-1',
    });

    const context = await registry.authenticate(grant.accessToken);
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const publicKey = keyPair.publicKey.export({
      type: 'spki',
      format: 'pem',
    }).toString();

    const pending = await registry.beginRegistration(context, {
      id: 'device-registry-1',
      name: 'Principal',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      publicKey,
    });

    const badSignature = crypto.randomBytes(64).toString('base64');
    await assert.rejects(
      registry.completeRegistration(context, {
        registrationId: pending.registrationId,
        deviceId: 'device-registry-1',
        signature: badSignature,
      }),
      /invalid_grant/,
    );

    const signature = crypto.sign(
      null,
      Buffer.from(pending.challenge, 'utf8'),
      keyPair.privateKey,
    ).toString('base64');

    const registered = await registry.completeRegistration(context, {
      registrationId: pending.registrationId,
      deviceId: 'device-registry-1',
      signature,
    });
    assert.equal(registered.id, 'device-registry-1');
    assert.equal(registered.name, 'Principal');

    const requestPath = '/v1/devices/list';
    const requestNonce = 'legacy-proof-nonce-1';
    const requestBodyHash = crypto.createHash('sha256').update('{}', 'utf8').digest('base64url');
    const requestChallenge = `autocodez-device-v1\n${requestPath}\n${now}\n${requestNonce}\n${requestBodyHash}`;

    await assert.rejects(
      registry.authenticateDeviceRequest(context, {
        deviceId: 'device-registry-1',
        pathname: requestPath,
        timestamp: now,
        nonce: requestNonce,
        bodyHash: requestBodyHash,
        signature: crypto.randomBytes(64).toString('base64'),
      }),
      /forbidden/,
    );

    const requestProof = {
      deviceId: 'device-registry-1',
      pathname: requestPath,
      timestamp: now,
      nonce: requestNonce,
      bodyHash: requestBodyHash,
      signature: crypto.sign(
        null,
        Buffer.from(requestChallenge, 'utf8'),
        keyPair.privateKey,
      ).toString('base64'),
    };
    const boundContext = await registry.authenticateDeviceRequest(context, requestProof);
    assert.equal(boundContext.deviceId, 'device-registry-1');

    await assert.rejects(
      registry.authenticateDeviceRequest(context, requestProof),
      /forbidden/,
    );

    const listed = await registry.list(boundContext);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.revokedAt, undefined);

    now += 1_000;
    await registry.revoke(boundContext, 'device-registry-1');

    await assert.rejects(
      registry.authenticate(grant.accessToken),
      /invalid_token/,
    );
  } finally {
    await database.close();
  }
});


test('desktop auth flow enforces PKCE, state, nonce and one-time exchange', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    let now = 1_800_000_000_000;
    const flows = new DesktopAuthFlowService(database, () => now);
    const verifier = 'v'.repeat(64);
    const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');

    const started = await flows.begin({
      kind: 'oauth',
      deviceId: 'device-flow-1',
      provider: 'github',
      state: 'outer-state-1',
      nonce: 'outer-nonce-1',
      codeChallenge: challenge,
    });

    const finished = await flows.finishBrowser({
      flowId: started.flowId,
      kind: 'oauth',
      user: {
        id: 'browser-user-1',
        email: 'flow@example.com',
        name: 'Flow User',
      },
    });

    await assert.rejects(
      flows.exchange({
        kind: 'oauth',
        flowId: started.flowId,
        provider: 'github',
        deviceId: 'device-flow-1',
        oneTimeToken: finished.oneTimeToken,
        state: 'outer-state-1',
        nonce: 'outer-nonce-1',
        codeVerifier: 'wrong-verifier',
      }),
      /invalid_grant/,
    );

    const exchanged = await flows.exchange({
      kind: 'oauth',
      flowId: started.flowId,
      provider: 'github',
      deviceId: 'device-flow-1',
      oneTimeToken: finished.oneTimeToken,
      state: 'outer-state-1',
      nonce: 'outer-nonce-1',
      codeVerifier: verifier,
    });

    assert.equal(exchanged.user.id, 'browser-user-1');
    assert.equal(exchanged.provider, 'github');

    await assert.rejects(
      flows.exchange({
        kind: 'oauth',
        flowId: started.flowId,
        provider: 'github',
        deviceId: 'device-flow-1',
        oneTimeToken: finished.oneTimeToken,
        state: 'outer-state-1',
        nonce: 'outer-nonce-1',
        codeVerifier: verifier,
      }),
      /invalid_grant/,
    );
  } finally {
    await database.close();
  }
});


test('session revoke requires refresh-token proof and invalidates later refreshes', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    const sessions = new DesktopSessionService(database, env, () => 1_800_000_000_000);
    const grant = await sessions.issue({
      user: {
        id: 'user-revoke-1',
        email: 'revoke@example.com',
        name: 'Revoke User',
      },
      provider: 'microsoft',
      deviceId: 'device-revoke-1',
    });

    await assert.rejects(
      sessions.revoke({
        sessionId: grant.session.id,
        deviceId: 'device-revoke-1',
      }),
      /invalid_grant/,
    );

    await sessions.revoke({
      sessionId: grant.session.id,
      deviceId: 'device-revoke-1',
      refreshToken: grant.refreshToken,
    });

    await assert.rejects(
      sessions.refresh(grant.refreshToken, 'device-revoke-1'),
      /invalid_grant/,
    );
  } finally {
    await database.close();
  }
});


test('Device Registry isolates the same physical device id between accounts', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    let now = 1_800_000_000_000;
    const sessions = new DesktopSessionService(database, env, () => now);
    const registry = new DeviceRegistryService(database, env, () => now);
    const deviceId = 'shared-physical-device';
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const publicKey = keyPair.publicKey.export({
      type: 'spki',
      format: 'pem',
    }).toString();

    async function register(
      userId: string,
      email: string,
      name: string,
    ) {
      const grant = await sessions.issue({
        user: { id: userId, email, name },
        provider: 'github',
        deviceId,
      });
      const context = await registry.authenticate(grant.accessToken);
      const pending = await registry.beginRegistration(context, {
        id: deviceId,
        name,
        platform: 'win32',
        arch: 'x64',
        appVersion: '2.0.0-test',
        publicKey,
      });
      const signature = crypto.sign(
        null,
        Buffer.from(pending.challenge, 'utf8'),
        keyPair.privateKey,
      ).toString('base64');
      await registry.completeRegistration(context, {
        registrationId: pending.registrationId,
        deviceId,
        signature,
      });
      return { grant, context };
    }

    const first = await register('user-shared-a', 'a@example.com', 'Conta A');
    now += 1_000;
    const second = await register('user-shared-b', 'b@example.com', 'Conta B');

    const firstDevices = await registry.list(first.context);
    const secondDevices = await registry.list(second.context);
    assert.deepEqual(firstDevices.map((device) => device.name), ['Conta A']);
    assert.deepEqual(secondDevices.map((device) => device.name), ['Conta B']);

    now += 1_000;
    await registry.revoke(second.context, deviceId);
    await assert.rejects(registry.authenticate(second.grant.accessToken), /invalid_token/);

    const firstContextAfterSecondRevoke = await registry.authenticate(first.grant.accessToken);
    const firstDevicesAfterSecondRevoke = await registry.list(firstContextAfterSecondRevoke);
    assert.equal(firstDevicesAfterSecondRevoke.length, 1);
    assert.equal(firstDevicesAfterSecondRevoke[0]?.name, 'Conta A');
    assert.equal(firstDevicesAfterSecondRevoke[0]?.revokedAt, undefined);
  } finally {
    await database.close();
  }
});


test('desktop account keeps multiple linked authentication identities for the same Better Auth user', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    let now = 1_800_000_000_000;
    const sessions = new DesktopSessionService(database, env, () => now);
    const user = {
      id: 'user-multi-identity-1',
      email: 'linked@example.com',
      name: 'Linked User',
    };

    const github = await sessions.issue({
      user,
      provider: 'github',
      deviceId: 'device-linked-1',
    });

    now += 1_000;
    const google = await sessions.issue({
      user,
      provider: 'google',
      deviceId: 'device-linked-1',
    });

    assert.equal(github.account.id, user.id);
    assert.equal(google.account.id, user.id);
    assert.deepEqual(
      google.account.identities.map((identity) => identity.provider).sort(),
      ['github', 'google'],
    );

    const rows = await database.query<{ provider: string }>(
      'SELECT provider FROM desktop_identity WHERE user_id = $1 ORDER BY provider ASC',
      [user.id],
    );
    assert.deepEqual(rows.map((row) => row.provider), ['github', 'google']);
  } finally {
    await database.close();
  }
});


test('Device Registry accepts a Descope subject without legacy desktop account or session rows', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    const verifier: DeviceAccessVerifier = {
      async validate(token) {
        assert.equal(token, 'descope-session-token');
        return { userId: 'descope-user-standalone' };
      },
    };
    const registry = new DeviceRegistryService(database, undefined, () => 1_800_000_000_000, verifier);
    const context = await registry.authenticate('descope-session-token');
    assert.deepEqual(context, { userId: 'descope-user-standalone' });

    const keyPair = crypto.generateKeyPairSync('ed25519');
    const publicKey = keyPair.publicKey.export({
      type: 'spki',
      format: 'pem',
    }).toString();

    const pending = await registry.beginRegistration(context, {
      id: 'descope-device-1',
      name: 'PC Descope',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      publicKey,
    });
    const signature = crypto.sign(
      null,
      Buffer.from(pending.challenge, 'utf8'),
      keyPair.privateKey,
    ).toString('base64');

    const registered = await registry.completeRegistration(context, {
      registrationId: pending.registrationId,
      deviceId: 'descope-device-1',
      signature,
    });
    assert.equal(registered.id, 'descope-device-1');
    assert.equal(registered.name, 'PC Descope');

    const accountRows = await database.query<{ user_id: string }>(
      'SELECT user_id FROM desktop_account WHERE user_id = $1',
      ['descope-user-standalone'],
    );
    assert.deepEqual(accountRows, []);

    const listed = await registry.list(context);
    assert.deepEqual(listed.map((device) => device.id), ['descope-device-1']);

    await registry.revoke(context, 'descope-device-1');
    const revoked = await registry.list(context);
    assert.equal(revoked[0]?.revokedAt !== undefined, true);

    await assert.rejects(
      registry.beginRegistration(context, {
        id: 'descope-device-1',
        name: 'PC Descope',
        platform: 'win32',
        arch: 'x64',
        appVersion: '2.0.0-test',
        publicKey,
      }),
      /device_revoked/,
    );
  } finally {
    await database.close();
  }
});


test('Device Registry prevents public-key replacement for an existing active device', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    const verifier: DeviceAccessVerifier = {
      async validate() {
        return { userId: 'descope-key-binding-user' };
      },
    };
    let now = 1_800_000_000_000;
    const registry = new DeviceRegistryService(database, undefined, () => now, verifier);
    const context = await registry.authenticate('descope-session-token');
    const originalKeys = crypto.generateKeyPairSync('ed25519');
    const replacementKeys = crypto.generateKeyPairSync('ed25519');
    const originalPublicKey = originalKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const replacementPublicKey = replacementKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const first = await registry.beginRegistration(context, {
      id: 'bound-device-1',
      name: 'PC Original',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      publicKey: originalPublicKey,
    });
    const firstSignature = crypto.sign(
      null,
      Buffer.from(first.challenge, 'utf8'),
      originalKeys.privateKey,
    ).toString('base64');
    await registry.completeRegistration(context, {
      registrationId: first.registrationId,
      deviceId: 'bound-device-1',
      signature: firstSignature,
    });

    await assert.rejects(
      registry.beginRegistration(context, {
        id: 'bound-device-1',
        name: 'PC Substituído',
        platform: 'win32',
        arch: 'x64',
        appVersion: '2.0.1-test',
        publicKey: replacementPublicKey,
      }),
      /forbidden/,
    );

    const rows = await database.query<{ public_key: string }>(
      'SELECT public_key FROM device_registry WHERE user_id = $1 AND device_id = $2',
      ['descope-key-binding-user', 'bound-device-1'],
    );
    assert.equal(rows[0]?.public_key, originalPublicKey);
  } finally {
    await database.close();
  }
});

test('Device Registry rejects a racing registration that tries to replace the winning device key', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    const verifier: DeviceAccessVerifier = {
      async validate() {
        return { userId: 'descope-key-race-user' };
      },
    };
    let now = 1_800_000_000_000;
    const registry = new DeviceRegistryService(database, undefined, () => now, verifier);
    const context = await registry.authenticate('descope-session-token');
    const firstKeys = crypto.generateKeyPairSync('ed25519');
    const secondKeys = crypto.generateKeyPairSync('ed25519');
    const firstPublicKey = firstKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const secondPublicKey = secondKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const first = await registry.beginRegistration(context, {
      id: 'race-device-1',
      name: 'Primeiro',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      publicKey: firstPublicKey,
    });
    const second = await registry.beginRegistration(context, {
      id: 'race-device-1',
      name: 'Segundo',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      publicKey: secondPublicKey,
    });

    await registry.completeRegistration(context, {
      registrationId: first.registrationId,
      deviceId: 'race-device-1',
      signature: crypto.sign(
        null,
        Buffer.from(first.challenge, 'utf8'),
        firstKeys.privateKey,
      ).toString('base64'),
    });

    await assert.rejects(
      registry.completeRegistration(context, {
        registrationId: second.registrationId,
        deviceId: 'race-device-1',
        signature: crypto.sign(
          null,
          Buffer.from(second.challenge, 'utf8'),
          secondKeys.privateKey,
        ).toString('base64'),
      }),
      /forbidden/,
    );

    const rows = await database.query<{ public_key: string }>(
      'SELECT public_key FROM device_registry WHERE user_id = $1 AND device_id = $2',
      ['descope-key-race-user', 'race-device-1'],
    );
    assert.equal(rows[0]?.public_key, firstPublicKey);
  } finally {
    await database.close();
  }
});

test('Device Registry allows same-key re-registration and keeps the bound key immutable', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    const verifier: DeviceAccessVerifier = {
      async validate() {
        return { userId: 'descope-same-key-user' };
      },
    };
    let now = 1_800_000_000_000;
    const registry = new DeviceRegistryService(database, undefined, () => now, verifier);
    const context = await registry.authenticate('descope-session-token');
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const register = async (name: string, appVersion: string) => {
      const pending = await registry.beginRegistration(context, {
        id: 'same-key-device-1',
        name,
        platform: 'win32',
        arch: 'x64',
        appVersion,
        publicKey,
      });
      return await registry.completeRegistration(context, {
        registrationId: pending.registrationId,
        deviceId: 'same-key-device-1',
        signature: crypto.sign(
          null,
          Buffer.from(pending.challenge, 'utf8'),
          keys.privateKey,
        ).toString('base64'),
      });
    };

    await register('Nome Inicial', '2.0.0-test');
    now += 1_000;
    const updated = await register('Nome Atualizado', '2.0.1-test');

    assert.equal(updated.name, 'Nome Atualizado');
    assert.equal(updated.appVersion, '2.0.1-test');
    const rows = await database.query<{ public_key: string }>(
      'SELECT public_key FROM device_registry WHERE user_id = $1 AND device_id = $2',
      ['descope-same-key-user', 'same-key-device-1'],
    );
    assert.equal(rows[0]?.public_key, publicKey);
  } finally {
    await database.close();
  }
});

test('Device Registry rejects non-Ed25519 registration keys', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    const verifier: DeviceAccessVerifier = {
      async validate() {
        return { userId: 'descope-invalid-key-user' };
      },
    };
    const registry = new DeviceRegistryService(database, undefined, () => 1_800_000_000_000, verifier);
    const context = await registry.authenticate('descope-session-token');
    const rsaKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = rsaKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await assert.rejects(
      registry.beginRegistration(context, {
        id: 'invalid-key-device-1',
        name: 'RSA Device',
        platform: 'win32',
        arch: 'x64',
        appVersion: '2.0.0-test',
        publicKey,
      }),
      /public key invalid/,
    );
  } finally {
    await database.close();
  }
});


test('revoked Descope device proof cannot access registry with an otherwise valid session token', async () => {
  const env = environment();
  const database = new Database(env);
  try {
    await migrateDesktopSchema(database);
    await reset(database);

    let now = 1_800_000_000_000;
    const verifier: DeviceAccessVerifier = {
      async validate(token) {
        assert.equal(token, 'descope-device-proof-token');
        return { userId: 'descope-device-proof-user' };
      },
    };
    const registry = new DeviceRegistryService(database, undefined, () => now, verifier);
    const context = await registry.authenticate('descope-device-proof-token');
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const deviceId = 'descope-proof-device-1';

    const pending = await registry.beginRegistration(context, {
      id: deviceId,
      name: 'PC proof',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0-test',
      publicKey,
    });
    const registrationSignature = crypto.sign(
      null,
      Buffer.from(pending.challenge, 'utf8'),
      keyPair.privateKey,
    ).toString('base64');
    await registry.completeRegistration(context, {
      registrationId: pending.registrationId,
      deviceId,
      signature: registrationSignature,
    });

    const proof = (nonce: string) => {
      const pathname = '/v1/devices/list';
      const bodyHash = crypto.createHash('sha256').update('{}', 'utf8').digest('base64url');
      const challenge = `autocodez-device-v1\n${pathname}\n${now}\n${nonce}\n${bodyHash}`;
      return {
        deviceId,
        pathname,
        timestamp: now,
        nonce,
        bodyHash,
        signature: crypto.sign(null, Buffer.from(challenge, 'utf8'), keyPair.privateKey).toString('base64'),
      };
    };

    const originalProof = proof('proof-nonce-before-revoke');
    const bound = await registry.authenticateDeviceRequest(context, originalProof);
    assert.equal(bound.deviceId, deviceId);

    await assert.rejects(
      registry.authenticateDeviceRequest(context, originalProof),
      /forbidden/,
    );

    await registry.revoke(bound, deviceId);
    now += 1_000;

    await assert.rejects(
      registry.authenticateDeviceRequest(context, proof('proof-nonce-after-revoke')),
      /device_revoked/,
    );
  } finally {
    await database.close();
  }
});
