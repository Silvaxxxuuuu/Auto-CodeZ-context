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

    const listed = await registry.list(context);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.revokedAt, undefined);

    now += 1_000;
    await registry.revoke(context, 'device-registry-1');

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
