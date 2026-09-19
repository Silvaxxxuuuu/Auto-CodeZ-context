import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { AccountApiEnvironment } from '../../src/env.js';
import { Database } from '../../src/db.js';
import { DesktopSessionService } from '../../src/desktop-session.js';
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
    const schema = await fs.readFile(
      new URL('../../migrations/001_desktop_account.sql', import.meta.url),
      'utf8',
    );
    await database.pool.query(schema);
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
    const schema = await fs.readFile(
      new URL('../../migrations/001_desktop_account.sql', import.meta.url),
      'utf8',
    );
    await database.pool.query(schema);
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
