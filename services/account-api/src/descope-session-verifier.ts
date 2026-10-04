import crypto from 'node:crypto';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type JwtClaims = {
  iss: string;
  sub: string;
  exp: number;
  iat?: number;
  aud?: string | string[];
};

type Jwk = {
  kty: 'RSA';
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
};

type CachedKeys = {
  expiresAt: number;
  keys: Jwk[];
};

export type DeviceAccessContext = {
  userId: string;
  sessionId?: string;
  deviceId?: string;
};

export interface DeviceAccessVerifier {
  validate(sessionToken: string): Promise<DeviceAccessContext>;
}

export interface DescopeSessionVerifierOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  cacheTtlMs?: number;
}

function requireProjectId(value: string): string {
  const projectId = value.trim();
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(projectId)) throw new Error('DESCOPE_PROJECT_ID is invalid.');
  return projectId;
}

function normalizeBaseUrl(value: string | undefined): string {
  const parsed = new URL(value?.trim() || 'https://api.descope.com');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('DESCOPE_BASE_URL is invalid.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_token');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, max = 2_048): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error('invalid_token');
  return value;
}

function numericValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid_token');
  return parsed;
}

function parseJwtSegment(segment: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')));
  } catch {
    throw new Error('invalid_token');
  }
}

function supportedIssuer(issuer: string, projectId: string): boolean {
  if (issuer === projectId) return true;
  try {
    const segments = new URL(issuer).pathname.split('/').filter(Boolean);
    return segments.at(-1) === projectId || segments.at(-2) === projectId;
  } catch {
    const segments = issuer.split('/').filter(Boolean);
    return segments.at(-1) === projectId || segments.at(-2) === projectId;
  }
}

function includesAudience(value: unknown, projectId: string): boolean {
  if (typeof value === 'string') return value === projectId;
  return Array.isArray(value) && value.some((entry) => entry === projectId);
}

export class DescopeSessionVerifier implements DeviceAccessVerifier {
  private readonly projectId: string;
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private sessionKeys?: CachedKeys;
  private oidcKeys?: CachedKeys;

  constructor(projectId: string, options: DescopeSessionVerifierOptions = {}) {
    this.projectId = requireProjectId(projectId);
    this.origin = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      throw new Error('DESCOPE session validation timeout is invalid.');
    }
  }

  async validate(sessionToken: string): Promise<DeviceAccessContext> {
    const token = sessionToken.trim();
    if (!token || token.length > 65_536) throw new Error('invalid_token');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('invalid_token');

    const header = parseJwtSegment(parts[0]);
    const payload = parseJwtSegment(parts[1]);
    if (stringValue(header.alg, 32) !== 'RS256') throw new Error('invalid_token');
    const kid = stringValue(header.kid, 512);

    const claims: JwtClaims = {
      iss: stringValue(payload.iss),
      sub: stringValue(payload.sub, 512),
      exp: numericValue(payload.exp),
      ...(payload.iat !== undefined ? { iat: numericValue(payload.iat) } : {}),
      ...(typeof payload.aud === 'string' || Array.isArray(payload.aud)
        ? { aud: payload.aud as string | string[] }
        : {}),
    };

    const nowSeconds = Math.floor(this.now() / 1_000);
    if (claims.exp <= nowSeconds - 5) throw new Error('expired_token');
    if (claims.iat !== undefined && claims.iat > nowSeconds + 300) throw new Error('invalid_token');
    if (!supportedIssuer(claims.iss, this.projectId)) throw new Error('invalid_token');
    if (!includesAudience(claims.aud, this.projectId)) throw new Error('invalid_token');

    const jwk = await this.findSigningKey(kid);
    if (!jwk) throw new Error('invalid_token');

    let publicKey: crypto.KeyObject;
    try {
      publicKey = crypto.createPublicKey({
        key: {
          kty: 'RSA',
          kid: jwk.kid,
          n: jwk.n,
          e: jwk.e,
          ...(jwk.alg ? { alg: jwk.alg } : {}),
          ...(jwk.use ? { use: jwk.use } : {}),
        },
        format: 'jwk',
      });
    } catch {
      throw new Error('invalid_token');
    }

    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!valid) throw new Error('invalid_token');

    return { userId: claims.sub };
  }

  private async findSigningKey(kid: string): Promise<Jwk | undefined> {
    for (const keySet of ['session', 'oidc'] as const) {
      let keys = await this.keys(keySet, false);
      let match = keys.find((key) => key.kid === kid && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      if (match) return match;

      keys = await this.keys(keySet, true);
      match = keys.find((key) => key.kid === kid && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
      if (match) return match;
    }
    return undefined;
  }

  private async keys(kind: 'session' | 'oidc', forceRefresh: boolean): Promise<Jwk[]> {
    const cache = kind === 'session' ? this.sessionKeys : this.oidcKeys;
    if (!forceRefresh && cache && cache.expiresAt > this.now()) return cache.keys;

    const pathname = kind === 'session'
      ? '/v2/keys/' + encodeURIComponent(this.projectId)
      : '/' + encodeURIComponent(this.projectId) + '/.well-known/jwks.json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(pathname, this.origin), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('identity_unavailable');
      const source = objectValue(await response.json());
      if (!Array.isArray(source.keys)) throw new Error('identity_unavailable');

      const keys: Jwk[] = [];
      for (const entry of source.keys) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const candidate = entry as Record<string, unknown>;
        if (candidate.kty !== 'RSA') continue;
        if (typeof candidate.kid !== 'string' || !candidate.kid) continue;
        if (typeof candidate.n !== 'string' || !candidate.n) continue;
        if (typeof candidate.e !== 'string' || !candidate.e) continue;
        keys.push({
          kty: 'RSA',
          kid: candidate.kid,
          n: candidate.n,
          e: candidate.e,
          ...(typeof candidate.alg === 'string' ? { alg: candidate.alg } : {}),
          ...(typeof candidate.use === 'string' ? { use: candidate.use } : {}),
        });
      }
      if (!keys.length) throw new Error('identity_unavailable');
      const value = { keys, expiresAt: this.now() + this.cacheTtlMs };
      if (kind === 'session') this.sessionKeys = value;
      else this.oidcKeys = value;
      return keys;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('identity_unavailable');
      if (error instanceof Error && (error.message === 'invalid_token' || error.message === 'expired_token')) throw error;
      throw new Error('identity_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}
