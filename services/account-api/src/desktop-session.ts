import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './db.js';
import type { AccountApiEnvironment } from './env.js';
import { randomToken, signAccessToken, tokenHash } from './crypto.js';
import type {
  AuthGrant,
  BrowserUser,
  DesktopAccount,
  DesktopSession,
  IdentityProvider,
} from './models.js';

const ACCESS_TTL_SECONDS = 10 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type AccountRow = {
  user_id: string;
  primary_email: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  status: 'active' | 'disabled' | 'pending_deletion';
  created_at_ms: string | number;
  updated_at_ms: string | number;
};

type IdentityRow = {
  id: string;
  provider: IdentityProvider;
  provider_account_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  linked_at_ms: string | number;
  last_used_at_ms: string | number | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  device_id: string;
  provider: IdentityProvider;
  created_at_ms: string | number;
  last_activity_at_ms: string | number;
  refresh_expires_at_ms: string | number;
  revoked_at_ms: string | number | null;
};

type RefreshRow = {
  id: string;
  session_id: string;
  token_hash: string;
  expires_at_ms: string | number;
  consumed_at_ms: string | number | null;
};

function numberValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function usernameFrom(user: BrowserUser): string {
  const base = (user.name || user.email.split('@')[0] || 'user')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'user';
  return `${base}-${user.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase() || 'acct'}`;
}

async function loadAccount(client: PoolClient, userId: string): Promise<DesktopAccount> {
  const accountResult = await client.query<AccountRow>(
    `SELECT user_id, primary_email, display_name, username, avatar_url, status,
            EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
            EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at_ms
       FROM desktop_account
      WHERE user_id = $1`,
    [userId],
  );
  const account = accountResult.rows[0];
  if (!account) throw new Error('not_found');

  const identitiesResult = await client.query<IdentityRow>(
    `SELECT id, provider, provider_account_id, email, display_name, avatar_url,
            EXTRACT(EPOCH FROM linked_at) * 1000 AS linked_at_ms,
            EXTRACT(EPOCH FROM last_used_at) * 1000 AS last_used_at_ms
       FROM desktop_identity
      WHERE user_id = $1
      ORDER BY linked_at ASC`,
    [userId],
  );

  return {
    id: account.user_id,
    primaryEmail: account.primary_email,
    displayName: account.display_name,
    ...(account.username ? { username: account.username } : {}),
    ...(account.avatar_url ? { avatarUrl: account.avatar_url } : {}),
    status: account.status,
    identities: identitiesResult.rows.map((identity) => ({
      id: identity.id,
      provider: identity.provider,
      providerAccountId: identity.provider_account_id,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.display_name ? { displayName: identity.display_name } : {}),
      ...(identity.avatar_url ? { avatarUrl: identity.avatar_url } : {}),
      linkedAt: numberValue(identity.linked_at_ms),
      ...(identity.last_used_at_ms === null ? {} : { lastUsedAt: numberValue(identity.last_used_at_ms) }),
    })),
    createdAt: numberValue(account.created_at_ms),
    updatedAt: numberValue(account.updated_at_ms),
  };
}

async function upsertDesktopAccount(
  client: PoolClient,
  user: BrowserUser,
  provider: IdentityProvider,
  nowMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO desktop_account (
       user_id, primary_email, display_name, username, avatar_url, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))
     ON CONFLICT (user_id) DO UPDATE SET
       primary_email = EXCLUDED.primary_email,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       updated_at = EXCLUDED.updated_at`,
    [
      user.id,
      user.email,
      user.name || user.email.split('@')[0] || 'Auto CodeZ User',
      usernameFrom(user),
      user.image ?? null,
      nowMs,
    ],
  );

  await client.query(
    `INSERT INTO desktop_identity (
       id, user_id, provider, provider_account_id, email, display_name, avatar_url, linked_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0))
     ON CONFLICT (user_id, provider) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       last_used_at = EXCLUDED.last_used_at`,
    [
      crypto.randomUUID(),
      user.id,
      provider,
      `${user.id}:${provider}`,
      user.email,
      user.name,
      user.image ?? null,
      nowMs,
    ],
  );
}

function toDesktopSession(row: SessionRow, accessExpiresAt: number): DesktopSession {
  return {
    id: row.id,
    accountId: row.user_id,
    deviceId: row.device_id,
    identityProvider: row.provider,
    createdAt: numberValue(row.created_at_ms),
    lastActivityAt: numberValue(row.last_activity_at_ms),
    accessExpiresAt,
    refreshExpiresAt: numberValue(row.refresh_expires_at_ms),
    ...(row.revoked_at_ms === null ? {} : { revokedAt: numberValue(row.revoked_at_ms) }),
  };
}

function accessTokenFor(environment: AccountApiEnvironment, row: SessionRow, nowMs: number): {
  token: string;
  expiresAt: number;
} {
  const issuedAtSeconds = Math.floor(nowMs / 1000);
  const expiresAtSeconds = issuedAtSeconds + ACCESS_TTL_SECONDS;
  return {
    token: signAccessToken({
      secret: environment.accessTokenSecret,
      issuer: environment.publicUrl,
      audience: 'auto-codez-desktop',
      userId: row.user_id,
      sessionId: row.id,
      deviceId: row.device_id,
      issuedAtSeconds,
      expiresAtSeconds,
    }),
    expiresAt: expiresAtSeconds * 1000,
  };
}

export class DesktopSessionService {
  constructor(
    private readonly database: Database,
    private readonly environment: AccountApiEnvironment,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(input: {
    user: BrowserUser;
    provider: IdentityProvider;
    deviceId: string;
  }): Promise<AuthGrant> {
    const nowMs = this.now();
    return await this.database.transaction(async (client) => {
      await upsertDesktopAccount(client, input.user, input.provider, nowMs);

      const sessionId = crypto.randomUUID();
      const refreshToken = randomToken();
      const refreshExpiresAt = nowMs + REFRESH_TTL_MS;

      await client.query(
        `INSERT INTO desktop_session (
          id, user_id, device_id, provider, created_at, last_activity_at, refresh_expires_at
        ) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))`,
        [sessionId, input.user.id, input.deviceId, input.provider, nowMs, refreshExpiresAt],
      );

      await client.query(
        `INSERT INTO desktop_refresh_token (
          id, session_id, token_hash, expires_at, created_at
        ) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))`,
        [crypto.randomUUID(), sessionId, tokenHash(refreshToken), refreshExpiresAt, nowMs],
      );

      const row: SessionRow = {
        id: sessionId,
        user_id: input.user.id,
        device_id: input.deviceId,
        provider: input.provider,
        created_at_ms: nowMs,
        last_activity_at_ms: nowMs,
        refresh_expires_at_ms: refreshExpiresAt,
        revoked_at_ms: null,
      };
      const access = accessTokenFor(this.environment, row, nowMs);
      return {
        account: await loadAccount(client, input.user.id),
        session: toDesktopSession(row, access.expiresAt),
        accessToken: access.token,
        refreshToken,
      };
    });
  }

  async refresh(refreshToken: string, deviceId: string): Promise<AuthGrant> {
    const nowMs = this.now();
    const hash = tokenHash(refreshToken);

    const outcome = await this.database.transaction(async (client) => {
      const tokenResult = await client.query<RefreshRow & SessionRow>(
        `SELECT rt.id, rt.session_id, rt.token_hash,
                EXTRACT(EPOCH FROM rt.expires_at) * 1000 AS expires_at_ms,
                EXTRACT(EPOCH FROM rt.consumed_at) * 1000 AS consumed_at_ms,
                s.user_id, s.device_id, s.provider,
                EXTRACT(EPOCH FROM s.created_at) * 1000 AS created_at_ms,
                EXTRACT(EPOCH FROM s.last_activity_at) * 1000 AS last_activity_at_ms,
                EXTRACT(EPOCH FROM s.refresh_expires_at) * 1000 AS refresh_expires_at_ms,
                EXTRACT(EPOCH FROM s.revoked_at) * 1000 AS revoked_at_ms
           FROM desktop_refresh_token rt
           JOIN desktop_session s ON s.id = rt.session_id
          WHERE rt.token_hash = $1
          FOR UPDATE`,
        [hash],
      );
      const row = tokenResult.rows[0];
      if (!row || row.device_id !== deviceId || row.revoked_at_ms !== null) {
        return { kind: 'invalid' as const };
      }

      if (
        row.consumed_at_ms !== null
        || numberValue(row.expires_at_ms) <= nowMs
        || numberValue(row.refresh_expires_at_ms) <= nowMs
      ) {
        await client.query(
          'UPDATE desktop_session SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
          [row.session_id],
        );
        return { kind: 'invalid' as const };
      }

      await client.query(
        'UPDATE desktop_refresh_token SET consumed_at = to_timestamp($2 / 1000.0) WHERE id = $1',
        [row.id, nowMs],
      );

      const nextRefresh = randomToken();
      await client.query(
        `INSERT INTO desktop_refresh_token (
          id, session_id, token_hash, expires_at, created_at
        ) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))`,
        [crypto.randomUUID(), row.session_id, tokenHash(nextRefresh), numberValue(row.refresh_expires_at_ms), nowMs],
      );

      await client.query(
        'UPDATE desktop_session SET last_activity_at = to_timestamp($2 / 1000.0) WHERE id = $1',
        [row.session_id, nowMs],
      );

      const updated: SessionRow = {
        ...row,
        last_activity_at_ms: nowMs,
      };
      const access = accessTokenFor(this.environment, updated, nowMs);
      return {
        kind: 'grant' as const,
        grant: {
          account: await loadAccount(client, row.user_id),
          session: toDesktopSession(updated, access.expiresAt),
          accessToken: access.token,
          refreshToken: nextRefresh,
        },
      };
    });

    if (outcome.kind !== 'grant') throw new Error('invalid_grant');
    return outcome.grant;
  }

  async revoke(input: {
    sessionId: string;
    refreshToken?: string;
    deviceId: string;
  }): Promise<void> {
    if (!input.refreshToken) throw new Error('invalid_grant');
    const hash = tokenHash(input.refreshToken);
    await this.database.transaction(async (client) => {
      const result = await client.query<{ session_id: string; device_id: string }>(
        `SELECT rt.session_id, s.device_id
           FROM desktop_refresh_token rt
           JOIN desktop_session s ON s.id = rt.session_id
          WHERE rt.token_hash = $1`,
        [hash],
      );
      const row = result.rows[0];
      if (!row || row.session_id !== input.sessionId || row.device_id !== input.deviceId) {
        throw new Error('invalid_grant');
      }

      await client.query(
        `UPDATE desktop_session
            SET revoked_at = NOW()
          WHERE id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [input.sessionId, input.deviceId],
      );
    });
  }
}
