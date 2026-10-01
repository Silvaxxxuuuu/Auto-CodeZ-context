import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './db.js';
import { randomToken, tokenHash, verifyPkceS256 } from './crypto.js';
import type { BrowserUser, IdentityProvider } from './models.js';

export type DesktopAuthFlowKind = 'oauth' | 'magic_link' | 'passkey';

type FlowRow = {
  id: string;
  kind: DesktopAuthFlowKind;
  device_id: string;
  provider: IdentityProvider;
  outer_state: string;
  outer_nonce: string | null;
  code_challenge: string;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  user_image: string | null;
  one_time_hash: string | null;
  expires_at_ms: string | number;
  one_time_expires_at_ms: string | number | null;
  consumed_at_ms: string | number | null;
};

const FLOW_TTL_MS = 10 * 60 * 1000;
const ONE_TIME_TTL_MS = 2 * 60 * 1000;

function numberValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function flowProvider(kind: DesktopAuthFlowKind, provider?: string): IdentityProvider {
  if (kind === 'magic_link') return 'magic_link';
  if (kind === 'passkey') return 'passkey';
  if (provider === 'github' || provider === 'google' || provider === 'microsoft') return provider;
  throw new Error('provider invalid.');
}

export class DesktopAuthFlowService {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(input: {
    kind: DesktopAuthFlowKind;
    deviceId: string;
    provider?: string;
    state: string;
    nonce?: string;
    codeChallenge: string;
    email?: string;
  }): Promise<{ flowId: string; expiresAt: number }> {
    const nowMs = this.now();
    const expiresAt = nowMs + FLOW_TTL_MS;
    const flowId = crypto.randomUUID();
    const provider = flowProvider(input.kind, input.provider);

    await this.database.query(
      `INSERT INTO desktop_auth_flow (
        id, kind, device_id, provider, outer_state, outer_nonce, code_challenge,
        requested_email, created_at, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0)
      )`,
      [
        flowId,
        input.kind,
        input.deviceId,
        provider,
        input.state,
        input.nonce ?? null,
        input.codeChallenge,
        input.email ?? null,
        nowMs,
        expiresAt,
      ],
    );

    return { flowId, expiresAt };
  }

  async finishBrowser(input: {
    flowId: string;
    kind: DesktopAuthFlowKind;
    user: BrowserUser;
  }): Promise<{ oneTimeToken: string; state: string }> {
    const nowMs = this.now();
    return await this.database.transaction(async (client) => {
      const flow = await this.lockFlow(client, input.flowId);
      if (flow.kind !== input.kind) throw new Error('invalid_grant');
      this.assertFlowUsable(flow, nowMs, false);

      const oneTimeToken = randomToken(32);
      const oneTimeExpiresAt = nowMs + ONE_TIME_TTL_MS;
      await client.query(
        `UPDATE desktop_auth_flow
            SET user_id = $2,
                user_email = $3,
                user_name = $4,
                user_image = $5,
                one_time_hash = $6,
                one_time_expires_at = to_timestamp($7 / 1000.0)
          WHERE id = $1`,
        [
          flow.id,
          input.user.id,
          input.user.email,
          input.user.name,
          input.user.image ?? null,
          tokenHash(oneTimeToken),
          oneTimeExpiresAt,
        ],
      );
      return { oneTimeToken, state: flow.outer_state };
    });
  }

  async exchange(input: {
    flowId: string;
    kind: DesktopAuthFlowKind;
    deviceId: string;
    oneTimeToken: string;
    state: string;
    nonce?: string;
    codeVerifier: string;
    provider?: string;
  }): Promise<{ user: BrowserUser; provider: IdentityProvider }> {
    const nowMs = this.now();

    return await this.database.transaction(async (client) => {
      const flow = await this.lockFlow(client, input.flowId);
      if (flow.kind !== input.kind || flow.device_id !== input.deviceId) throw new Error('invalid_grant');
      if (flow.provider !== flowProvider(input.kind, input.provider)) throw new Error('invalid_grant');
      this.assertFlowUsable(flow, nowMs, true);

      if (flow.outer_state !== input.state) throw new Error('invalid_grant');
      if (flow.outer_nonce !== null && flow.outer_nonce !== (input.nonce ?? '')) throw new Error('invalid_grant');
      if (!verifyPkceS256(input.codeVerifier, flow.code_challenge)) throw new Error('invalid_grant');
      if (!flow.one_time_hash || tokenHash(input.oneTimeToken) !== flow.one_time_hash) throw new Error('invalid_grant');
      if (!flow.user_id || !flow.user_email || !flow.user_name) throw new Error('invalid_grant');

      await client.query(
        'UPDATE desktop_auth_flow SET consumed_at = to_timestamp($2 / 1000.0) WHERE id = $1',
        [flow.id, nowMs],
      );

      return {
        user: {
          id: flow.user_id,
          email: flow.user_email,
          name: flow.user_name,
          ...(flow.user_image ? { image: flow.user_image } : {}),
        },
        provider: flow.provider,
      };
    });
  }

  async get(flowId: string): Promise<{
    id: string;
    kind: DesktopAuthFlowKind;
    provider: IdentityProvider;
    state: string;
    email?: string;
  }> {
    const rows = await this.database.query<{
      id: string;
      kind: DesktopAuthFlowKind;
      provider: IdentityProvider;
      outer_state: string;
      requested_email: string | null;
      expires_at_ms: string | number;
      consumed_at_ms: string | number | null;
    }>(
      `SELECT id, kind, provider, outer_state, requested_email,
              EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_at_ms,
              EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_at_ms
         FROM desktop_auth_flow
        WHERE id = $1`,
      [flowId],
    );
    const flow = rows[0];
    if (!flow || flow.consumed_at_ms !== null || numberValue(flow.expires_at_ms) <= this.now()) throw new Error('invalid_grant');
    return {
      id: flow.id,
      kind: flow.kind,
      provider: flow.provider,
      state: flow.outer_state,
      ...(flow.requested_email ? { email: flow.requested_email } : {}),
    };
  }

  private async lockFlow(client: PoolClient, flowId: string): Promise<FlowRow> {
    const result = await client.query<FlowRow>(
      `SELECT id, kind, device_id, provider, outer_state, outer_nonce, code_challenge,
              user_id, user_email, user_name, user_image, one_time_hash,
              EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_at_ms,
              EXTRACT(EPOCH FROM one_time_expires_at) * 1000 AS one_time_expires_at_ms,
              EXTRACT(EPOCH FROM consumed_at) * 1000 AS consumed_at_ms
         FROM desktop_auth_flow
        WHERE id = $1
        FOR UPDATE`,
      [flowId],
    );
    const flow = result.rows[0];
    if (!flow) throw new Error('invalid_grant');
    return flow;
  }

  private assertFlowUsable(flow: FlowRow, nowMs: number, requireOneTime: boolean): void {
    if (flow.consumed_at_ms !== null || numberValue(flow.expires_at_ms) <= nowMs) throw new Error('invalid_grant');
    if (requireOneTime) {
      if (flow.one_time_expires_at_ms === null || numberValue(flow.one_time_expires_at_ms) <= nowMs) {
        throw new Error('invalid_grant');
      }
    }
  }
}
