import crypto from 'node:crypto';
import type { Database } from './db.js';
import type { AccountApiEnvironment } from './env.js';
import { verifyAccessToken } from './crypto.js';
import type { DeviceAccessContext, DeviceAccessVerifier } from './descope-session-verifier.js';

type AccessContext = DeviceAccessContext;

type DeviceRow = {
  device_id: string;
  name: string;
  platform: string;
  arch: string;
  app_version: string;
  public_key: string;
  created_at_ms: string | number;
  last_seen_at_ms: string | number;
  revoked_at_ms: string | number | null;
};

type RegistrationRow = {
  registration_id: string;
  user_id: string;
  device_id: string;
  name: string;
  platform: string;
  arch: string;
  app_version: string;
  public_key: string;
  challenge: string;
  expires_at_ms: string | number;
  consumed_at_ms: string | number | null;
};

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

function numberValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toRemote(row: DeviceRow) {
  return {
    id: row.device_id,
    name: row.name,
    platform: row.platform,
    arch: row.arch,
    appVersion: row.app_version,
    createdAt: numberValue(row.created_at_ms),
    lastSeenAt: numberValue(row.last_seen_at_ms),
    ...(row.revoked_at_ms === null ? {} : { revokedAt: numberValue(row.revoked_at_ms) }),
  };
}

export class DeviceRegistryService {
  constructor(
    private readonly database: Database,
    private readonly environment: Pick<AccountApiEnvironment, 'publicUrl' | 'accessTokenSecret'> | undefined,
    private readonly now: () => number = Date.now,
    private readonly accessVerifier?: DeviceAccessVerifier,
  ) {}

  async authenticate(accessToken: string): Promise<AccessContext> {
    if (this.accessVerifier) return await this.accessVerifier.validate(accessToken);

    if (!this.environment) throw new Error('identity_unavailable');
    const claims = verifyAccessToken(accessToken, {
      secret: this.environment.accessTokenSecret,
      issuer: this.environment.publicUrl,
      audience: 'auto-codez-desktop',
      nowSeconds: Math.floor(this.now() / 1000),
    });

    const rows = await this.database.query<{ revoked_at_ms: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_at_ms
         FROM desktop_session
        WHERE id = $1 AND user_id = $2 AND device_id = $3`,
      [claims.sessionId, claims.userId, claims.deviceId],
    );
    const session = rows[0];
    if (!session || session.revoked_at_ms !== null) throw new Error('invalid_token');

    return {
      userId: claims.userId,
      sessionId: claims.sessionId,
      deviceId: claims.deviceId,
    };
  }

  async beginRegistration(context: AccessContext, device: {
    id: string;
    name: string;
    platform: string;
    arch: string;
    appVersion: string;
    publicKey: string;
  }): Promise<{ registrationId: string; challenge: string; expiresAt: number }> {
    if (context.deviceId && device.id !== context.deviceId) throw new Error('forbidden');
    if (!device.publicKey.includes('BEGIN PUBLIC KEY')) throw new Error('public key invalid.');

    const existing = await this.database.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM device_registry WHERE user_id = $1 AND device_id = $2',
      [context.userId, device.id],
    );
    if (existing[0]?.revoked_at) throw new Error('forbidden');

    const nowMs = this.now();
    const expiresAt = nowMs + CHALLENGE_TTL_MS;
    const registrationId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('base64url');

    await this.database.query(
      `INSERT INTO device_registration (
        registration_id, user_id, device_id, name, platform, arch,
        app_version, public_key, challenge, created_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        to_timestamp($10 / 1000.0), to_timestamp($11 / 1000.0)
      )`,
      [
        registrationId,
        context.userId,
        device.id,
        device.name,
        device.platform,
        device.arch,
        device.appVersion,
        device.publicKey,
        challenge,
        nowMs,
        expiresAt,
      ],
    );

    return { registrationId, challenge, expiresAt };
  }

  async completeRegistration(context: AccessContext, input: {
    registrationId: string;
    deviceId: string;
    signature: string;
  }) {
    const nowMs = this.now();

    return await this.database.transaction(async (client) => {
      const result = await client.query<RegistrationRow>(
        `SELECT registration_id, user_id, device_id, name, platform, arch,
                app_version, public_key, challenge,
                EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_at_ms,
                EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_at_ms
           FROM device_registration
          WHERE registration_id = $1
          FOR UPDATE`,
        [input.registrationId],
      );
      const registration = result.rows[0];
      if (
        !registration
        || registration.user_id !== context.userId
        || (context.deviceId !== undefined && registration.device_id !== context.deviceId)
        || registration.device_id !== input.deviceId
        || registration.consumed_at_ms !== null
        || numberValue(registration.expires_at_ms) <= nowMs
      ) {
        throw new Error('invalid_grant');
      }

      let valid = false;
      try {
        valid = crypto.verify(
          null,
          Buffer.from(registration.challenge, 'utf8'),
          registration.public_key,
          Buffer.from(input.signature, 'base64'),
        );
      } catch {
        valid = false;
      }
      if (!valid) throw new Error('invalid_grant');

      const existingDevice = await client.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM device_registry WHERE user_id = $1 AND device_id = $2 FOR UPDATE',
        [context.userId, registration.device_id],
      );
      if (existingDevice.rows[0]?.revoked_at) throw new Error('forbidden');

      await client.query(
        `INSERT INTO device_registry (
          device_id, user_id, name, platform, arch, app_version, public_key,
          created_at, last_seen_at, revoked_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0), NULL
        )
        ON CONFLICT (user_id, device_id) DO UPDATE SET
          name = EXCLUDED.name,
          platform = EXCLUDED.platform,
          arch = EXCLUDED.arch,
          app_version = EXCLUDED.app_version,
          public_key = EXCLUDED.public_key,
          last_seen_at = EXCLUDED.last_seen_at,
          revoked_at = NULL`,
        [
          registration.device_id,
          context.userId,
          registration.name,
          registration.platform,
          registration.arch,
          registration.app_version,
          registration.public_key,
          nowMs,
        ],
      );

      await client.query(
        'UPDATE device_registration SET consumed_at = to_timestamp($2 / 1000.0) WHERE registration_id = $1',
        [registration.registration_id, nowMs],
      );

      return await this.getById(client, context.userId, registration.device_id);
    });
  }

  async authenticateDeviceRequest(context: AccessContext, input: {
    deviceId: string;
    pathname: string;
    timestamp: number;
    nonce: string;
    bodyHash: string;
    signature: string;
  }): Promise<AccessContext> {
    if (context.deviceId) {
      if (context.deviceId !== input.deviceId) throw new Error('forbidden');
      return context;
    }

    const nowMs = this.now();
    if (
      !Number.isFinite(input.timestamp)
      || Math.abs(nowMs - input.timestamp) > 5 * 60_000
      || !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)
      || !/^[A-Za-z0-9_-]{20,128}$/.test(input.bodyHash)
      || input.signature.length > 16_384
    ) {
      throw new Error('forbidden');
    }

    return await this.database.transaction(async (client) => {
      const result = await client.query<{ public_key: string; revoked_at: Date | null }>(
        'SELECT public_key, revoked_at FROM device_registry WHERE user_id = $1 AND device_id = $2 FOR UPDATE',
        [context.userId, input.deviceId],
      );
      const device = result.rows[0];
      if (!device || device.revoked_at) throw new Error('forbidden');

      const challenge = `autocodez-device-v1\n${input.pathname}\n${input.timestamp}\n${input.nonce}\n${input.bodyHash}`;
      let valid = false;
      try {
        valid = crypto.verify(
          null,
          Buffer.from(challenge, 'utf8'),
          device.public_key,
          Buffer.from(input.signature, 'base64'),
        );
      } catch {
        valid = false;
      }
      if (!valid) throw new Error('forbidden');

      await client.query(
        'UPDATE device_registry SET last_seen_at = NOW() WHERE user_id = $1 AND device_id = $2',
        [context.userId, input.deviceId],
      );
      return { ...context, deviceId: input.deviceId };
    });
  }

  async list(context: AccessContext) {
    const rows = await this.database.query<DeviceRow>(
      `SELECT device_id, name, platform, arch, app_version, public_key,
              EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
              EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_at_ms,
              EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_at_ms
         FROM device_registry
        WHERE user_id = $1
        ORDER BY created_at ASC`,
      [context.userId],
    );
    return rows.map(toRemote);
  }

  async rename(context: AccessContext, deviceId: string, name: string) {
    const rows = await this.database.query<DeviceRow>(
      `UPDATE device_registry
          SET name = $3, last_seen_at = NOW()
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
      RETURNING device_id, name, platform, arch, app_version, public_key,
                EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
                EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_at_ms,
                EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_at_ms`,
      [context.userId, deviceId, name],
    );
    if (!rows[0]) throw new Error('not_found');
    return toRemote(rows[0]);
  }

  async revoke(context: AccessContext, deviceId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE device_registry
            SET revoked_at = NOW()
          WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [context.userId, deviceId],
      );
      if (result.rowCount === 0) throw new Error('not_found');

      await client.query(
        `UPDATE desktop_session
            SET revoked_at = NOW()
          WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [context.userId, deviceId],
      );
    });
  }

  private async getById(
    client: { query<T extends DeviceRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
    userId: string,
    deviceId: string,
  ) {
    const result = await client.query<DeviceRow>(
      `SELECT device_id, name, platform, arch, app_version, public_key,
              EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
              EXTRACT(EPOCH FROM last_seen_at) * 1000 AS last_seen_at_ms,
              EXTRACT(EPOCH FROM revoked_at) * 1000 AS revoked_at_ms
         FROM device_registry
        WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId],
    );
    if (!result.rows[0]) throw new Error('not_found');
    return toRemote(result.rows[0]);
  }
}
