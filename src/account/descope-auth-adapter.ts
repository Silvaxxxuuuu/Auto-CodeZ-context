import crypto from 'node:crypto';
import {
  AuthAdapterError,
  type AuthAdapter,
  type AuthGrant,
  type AuthMethod,
  type BeginHostedInput,
  type BeginMagicLinkInput,
  type BeginOAuthInput,
  type BeginPasskeyInput,
  type CompleteHostedInput,
  type CompleteMagicLinkInput,
  type CompleteOAuthInput,
  type CompletePasskeyInput,
  type OAuthProvider,
  type RefreshSessionInput,
  type RevokeSessionInput,
} from './auth-adapter';
import type { AccountProfile, AccountSession, DeviceId, IdentityProvider } from './types';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DescopeAuthAdapterOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

type OidcTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

type UserInfo = {
  sub: string;
  email: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
};

type DescopeUser = {
  userId: string;
  email: string;
  name?: string;
  picture?: string;
  loginIds: string[];
};

type DirectAuthResponse = {
  sessionJwt: string;
  refreshJwt?: string;
  sessionExpiration?: number;
  user?: DescopeUser;
};

type JwtHeader = {
  alg: string;
  kid: string;
};

type JwtClaims = {
  iss: string;
  sub: string;
  exp: number;
  iat?: number;
  aud?: string | string[];
  nonce?: string;
  azp?: string;
};

type CachedJwks = {
  expiresAt: number;
  keys: Array<{
    kty: 'RSA';
    kid: string;
    n: string;
    e: string;
    alg?: string;
    use?: string;
  }>;
};

const DIRECT_TOKEN_PREFIX = 'descope-direct:';
const OIDC_TOKEN_PREFIX = 'descope-oidc:';

function requireProjectId(value: string): string {
  const projectId = value.trim();
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(projectId)) {
    throw new Error('Project ID do Descope inválido.');
  }
  return projectId;
}

function normalizeBaseUrl(value: string | undefined): string {
  const parsed = new URL(value?.trim() || 'https://api.descope.com');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Base URL do Descope inválida.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function readJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthAdapterError('server', `${label} inválido retornado pelo serviço de autenticação.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max = 32_768): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AuthAdapterError('server', `${label} inválido retornado pelo serviço de autenticação.`);
  }
  return value.trim();
}

function optionalString(value: unknown, max = 8_192): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value;
}

function parseOidcTokenResponse(value: unknown, fallbackRefreshToken?: string): OidcTokenResponse {
  const source = readJsonObject(value, 'Resposta de token');
  const expires = Number(source.expires_in);
  return {
    access_token: requiredString(source.access_token, 'Access token'),
    refresh_token: optionalString(source.refresh_token, 32_768) || fallbackRefreshToken,
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : 3_600,
    id_token: optionalString(source.id_token, 32_768),
  };
}

function parseUserInfo(value: unknown): UserInfo {
  const source = readJsonObject(value, 'Perfil da conta');
  return {
    sub: requiredString(source.sub, 'ID da conta', 512),
    email: requiredString(source.email, 'E-mail', 254).toLowerCase(),
    name: optionalString(source.name, 256),
    preferred_username: optionalString(source.preferred_username, 128),
    picture: optionalString(source.picture, 2_048),
  };
}

function parseDescopeUser(value: unknown): DescopeUser {
  const source = readJsonObject(value, 'Perfil da conta');
  const rawLoginIds = Array.isArray(source.loginIds) ? source.loginIds : [];
  const loginIds = rawLoginIds
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 512)
    .map((entry) => entry.trim());

  const email = optionalString(source.email, 254)?.trim().toLowerCase()
    || loginIds.find((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))?.toLowerCase();
  if (!email) {
    throw new AuthAdapterError('server', 'O serviço de identidade não retornou um e-mail válido.');
  }

  return {
    userId: requiredString(source.userId, 'ID da conta', 512),
    email,
    name: optionalString(source.name, 256),
    picture: optionalString(source.picture, 2_048),
    loginIds,
  };
}

function parseDirectAuthResponse(value: unknown, fallbackRefreshToken?: string): DirectAuthResponse {
  const source = readJsonObject(value, 'Resposta de autenticação');
  const sessionExpiration = Number(source.sessionExpiration);
  return {
    sessionJwt: requiredString(source.sessionJwt, 'Session JWT'),
    refreshJwt: optionalString(source.refreshJwt, 65_536) || fallbackRefreshToken,
    sessionExpiration: Number.isFinite(sessionExpiration) && sessionExpiration > 0
      ? sessionExpiration
      : undefined,
    user: source.user ? parseDescopeUser(source.user) : undefined,
  };
}

function sessionId(refreshToken: string): string {
  return crypto.createHash('sha256').update(refreshToken, 'utf8').digest('hex').slice(0, 40);
}

function parseJwtObject<T>(segment: string, label: string): T {
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8');
    return readJsonObject(JSON.parse(decoded), label) as T;
  } catch {
    throw new AuthAdapterError('invalid_grant', `${label} inválido.`);
  }
}

function parseNumericClaim(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AuthAdapterError('invalid_grant', `${label} inválido no token.`);
  }
  return parsed;
}

function unwrapRefreshToken(value: string): { mode: 'direct' | 'oidc'; token: string } {
  if (value.startsWith(DIRECT_TOKEN_PREFIX)) {
    return { mode: 'direct', token: value.slice(DIRECT_TOKEN_PREFIX.length) };
  }
  if (value.startsWith(OIDC_TOKEN_PREFIX)) {
    return { mode: 'oidc', token: value.slice(OIDC_TOKEN_PREFIX.length) };
  }
  return { mode: 'oidc', token: value };
}

function wrapRefreshToken(mode: 'direct' | 'oidc', value: string): string {
  return (mode === 'direct' ? DIRECT_TOKEN_PREFIX : OIDC_TOKEN_PREFIX) + value;
}

function isSupportedIssuer(issuer: string, projectId: string): boolean {
  if (issuer === projectId) return true;
  try {
    const segments = new URL(issuer).pathname.split('/').filter(Boolean);
    return segments.at(-1) === projectId || segments.at(-2) === projectId;
  } catch {
    const segments = issuer.split('/').filter(Boolean);
    return segments.at(-1) === projectId || segments.at(-2) === projectId;
  }
}

export class DescopeAuthAdapter implements AuthAdapter {
  private readonly projectId: string;
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly hostedRedirectUri = 'autocodez://auth/hosted';
  private jwksCache?: CachedJwks;

  constructor(projectId: string, options: DescopeAuthAdapterOptions = {}) {
    this.projectId = requireProjectId(projectId);
    this.origin = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      throw new Error('Timeout do Descope inválido.');
    }
  }

  async configuration(): Promise<{ methods: AuthMethod[] }> {
    return { methods: ['magic_link', 'github', 'google', 'microsoft', 'passkey'] };
  }

  async beginHosted(input: BeginHostedInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    return this.beginHostedFlow(input.state, input.nonce, input.codeChallenge, this.hostedRedirectUri);
  }

  async completeHosted(input: CompleteHostedInput): Promise<AuthGrant> {
    return await this.completeHostedFlow(
      input.flowId,
      input.deviceId,
      input.code,
      input.codeVerifier,
      input.nonce,
      'descope',
      this.hostedRedirectUri,
    );
  }

  async beginOAuth(input: BeginOAuthInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    const flowId = crypto.randomUUID();
    const redirectUrl = new URL('autocodez://auth/oauth');
    redirectUrl.searchParams.set('flowId', flowId);
    redirectUrl.searchParams.set('state', input.state);

    const url = this.endpoint('/v1/auth/oauth/authorize');
    url.searchParams.set('provider', input.provider);
    url.searchParams.set('redirectURL', redirectUrl.toString());

    const source = readJsonObject(
      await this.descopeRequest(url, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      'Resposta de OAuth',
    );
    const authorizationUrl = requiredString(source.url, 'URL de autorização', 8_192);
    const parsed = new URL(authorizationUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new AuthAdapterError('server', 'URL de autorização OAuth insegura.');
    }

    return {
      authorizationUrl,
      flowId,
      expiresAt: this.now() + 10 * 60 * 1000,
    };
  }

  async completeOAuth(input: CompleteOAuthInput): Promise<AuthGrant> {
    if (!input.flowId.trim()) throw new AuthAdapterError('invalid_grant', 'Fluxo OAuth não encontrado.');
    const direct = parseDirectAuthResponse(
      await this.descopeRequest(this.endpoint('/v1/auth/oauth/exchange'), {
        method: 'POST',
        body: JSON.stringify({ code: input.code }),
      }),
    );
    return await this.grantFromDirect(direct, input.deviceId, input.provider);
  }

  async beginMagicLink(input: BeginMagicLinkInput): Promise<{ flowId: string; expiresAt: number }> {
    const flowId = crypto.randomUUID();
    const redirectUrl = new URL('autocodez://auth/magic-link');
    redirectUrl.searchParams.set('flowId', flowId);
    redirectUrl.searchParams.set('state', input.state);

    await this.descopeRequest(this.endpoint('/v1/auth/magiclink/signup-in/email'), {
      method: 'POST',
      body: JSON.stringify({
        loginId: input.email,
        URI: redirectUrl.toString(),
        loginOptions: {},
      }),
    });

    return {
      flowId,
      expiresAt: this.now() + 20 * 60 * 1000,
    };
  }

  async completeMagicLink(input: CompleteMagicLinkInput): Promise<AuthGrant> {
    if (!input.flowId.trim()) throw new AuthAdapterError('invalid_grant', 'Fluxo Magic Link não encontrado.');
    const direct = parseDirectAuthResponse(
      await this.descopeRequest(this.endpoint('/v1/auth/magiclink/verify'), {
        method: 'POST',
        body: JSON.stringify({ token: input.token }),
      }),
    );
    return await this.grantFromDirect(direct, input.deviceId, 'magic_link');
  }

  async beginPasskey(input: BeginPasskeyInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    return this.beginHostedFlow(
      input.state,
      input.nonce,
      input.codeChallenge,
      'autocodez://auth/passkey',
      'passkey',
    );
  }

  async completePasskey(input: CompletePasskeyInput): Promise<AuthGrant> {
    return await this.completeHostedFlow(
      input.flowId,
      input.deviceId,
      input.code,
      input.codeVerifier,
      input.nonce,
      'passkey',
      'autocodez://auth/passkey',
    );
  }

  async refresh(input: RefreshSessionInput): Promise<AuthGrant> {
    const refresh = unwrapRefreshToken(input.refreshToken);
    if (refresh.mode === 'oidc') {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.projectId,
        refresh_token: refresh.token,
      });
      const tokens = parseOidcTokenResponse(
        await this.formRequest('/oauth2/v1/token', body),
        refresh.token,
      );
      return await this.grantFromOidc(tokens, input.deviceId, undefined, 'descope');
    }

    const direct = parseDirectAuthResponse(
      await this.descopeRequest(this.endpoint('/v1/auth/refresh'), {
        method: 'POST',
        body: JSON.stringify({}),
      }, refresh.token),
      refresh.token,
    );
    return await this.grantFromDirect(direct, input.deviceId, 'descope', refresh.token);
  }

  async revoke(input: RevokeSessionInput): Promise<void> {
    if (!input.refreshToken) return;
    const refresh = unwrapRefreshToken(input.refreshToken);
    if (refresh.mode === 'direct') {
      await this.descopeRequest(
        this.endpoint('/v1/auth/logout'),
        { method: 'POST', body: JSON.stringify({}) },
        refresh.token,
        true,
      );
      return;
    }

    const body = new URLSearchParams({
      token: refresh.token,
      client_id: this.projectId,
    });
    await this.formRequest('/oauth2/v1/revoke', body, true);
  }

  private beginHostedFlow(
    state: string,
    nonce: string,
    codeChallenge: string,
    redirectUri: string,
    requestedMethod?: 'passkey',
  ): {
    authorizationUrl: string;
    flowId: string;
    expiresAt: number;
  } {
    const flowId = crypto.randomUUID();
    const url = this.endpoint('/oauth2/v1/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.projectId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email offline_access');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    if (requestedMethod) url.searchParams.set('autocodez_method', requestedMethod);

    return {
      authorizationUrl: url.toString(),
      flowId,
      expiresAt: this.now() + 10 * 60 * 1000,
    };
  }

  private async completeHostedFlow(
    flowId: string,
    deviceId: DeviceId,
    code: string,
    codeVerifier: string,
    nonce: string,
    provider: IdentityProvider,
    redirectUri: string,
  ): Promise<AuthGrant> {
    if (!flowId.trim()) throw new AuthAdapterError('invalid_grant', 'Fluxo de autenticação não encontrado.');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.projectId,
      code_verifier: codeVerifier,
    });
    const tokens = parseOidcTokenResponse(await this.formRequest('/oauth2/v1/token', body));
    if (!tokens.refresh_token) {
      throw new AuthAdapterError('server', 'O serviço de identidade não retornou refresh token.');
    }
    if (!tokens.id_token) {
      throw new AuthAdapterError('invalid_grant', 'O serviço de identidade não retornou ID token.');
    }
    const verifiedSubject = await this.verifyOidcIdToken(tokens.id_token, nonce);
    return await this.grantFromOidc(tokens, deviceId, verifiedSubject, provider);
  }

  private async grantFromDirect(
    response: DirectAuthResponse,
    deviceId: DeviceId,
    provider: IdentityProvider,
    fallbackRefreshToken?: string,
  ): Promise<AuthGrant> {
    const refreshToken = response.refreshJwt || fallbackRefreshToken;
    if (!refreshToken) throw new AuthAdapterError('server', 'Refresh token ausente.');

    const verified = await this.verifySessionJwt(response.sessionJwt);
    let user = response.user;
    if (!user) {
      user = parseDescopeUser(
        await this.descopeRequest(this.endpoint('/v1/auth/me'), { method: 'GET' }, refreshToken),
      );
    }
    if (user.userId !== verified.subject) {
      throw new AuthAdapterError('invalid_grant', 'Usuário da sessão não corresponde ao Session JWT.');
    }

    const wrappedRefresh = wrapRefreshToken('direct', refreshToken);
    return this.buildGrant(
      user,
      deviceId,
      provider,
      response.sessionJwt,
      wrappedRefresh,
      verified.expiresAt,
    );
  }

  private async grantFromOidc(
    tokens: OidcTokenResponse,
    deviceId: DeviceId,
    verifiedSubject?: string,
    provider: IdentityProvider = 'descope',
  ): Promise<AuthGrant> {
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new AuthAdapterError('server', 'Refresh token ausente.');

    const userInfo = parseUserInfo(await this.jsonRequest('/oauth2/v1/userinfo', {
      authorization: `Bearer ${tokens.access_token}`,
    }));
    if (verifiedSubject && userInfo.sub !== verifiedSubject) {
      throw new AuthAdapterError('invalid_grant', 'Subject do UserInfo não corresponde ao ID token.');
    }

    const now = this.now();
    const user: DescopeUser = {
      userId: userInfo.sub,
      email: userInfo.email,
      name: userInfo.name || userInfo.preferred_username,
      picture: userInfo.picture,
      loginIds: [userInfo.email],
    };
    return this.buildGrant(
      user,
      deviceId,
      provider,
      tokens.access_token,
      wrapRefreshToken('oidc', refreshToken),
      now + Math.max(60, tokens.expires_in ?? 3_600) * 1000,
      userInfo.preferred_username,
    );
  }

  private buildGrant(
    user: DescopeUser,
    deviceId: DeviceId,
    provider: IdentityProvider,
    accessToken: string,
    refreshToken: string,
    accessExpiresAt: number,
    username?: string,
  ): AuthGrant {
    const now = this.now();
    const displayName = user.name || user.email.split('@')[0] || 'Auto CodeZ User';
    const identity = {
      id: `${provider}:${user.userId}`,
      provider,
      providerAccountId: user.userId,
      email: user.email,
      displayName,
      ...(user.picture ? { avatarUrl: user.picture } : {}),
      linkedAt: now,
      lastUsedAt: now,
    };

    const account: AccountProfile = {
      id: user.userId,
      primaryEmail: user.email,
      displayName,
      ...(username ? { username } : {}),
      ...(user.picture ? { avatarUrl: user.picture } : {}),
      status: 'active',
      identities: [identity],
      createdAt: now,
      updatedAt: now,
    };

    const session: AccountSession = {
      id: sessionId(refreshToken),
      accountId: account.id,
      deviceId,
      identityProvider: provider,
      createdAt: now,
      lastActivityAt: now,
      accessExpiresAt,
    };

    return {
      account,
      session,
      accessToken,
      refreshToken,
    };
  }

  private async verifyOidcIdToken(idToken: string, expectedNonce: string): Promise<string> {
    const verified = await this.verifySignedJwt(idToken, 'ID token');
    const claims = verified.claims;
    const audienceValue = claims.aud;
    const audience = Array.isArray(audienceValue)
      ? audienceValue.filter((entry): entry is string => typeof entry === 'string')
      : typeof audienceValue === 'string'
        ? [audienceValue]
        : [];

    if (claims.iss !== `${this.origin}/${this.projectId}`) {
      throw new AuthAdapterError('invalid_grant', 'Issuer do ID token inválido.');
    }
    if (!audience.includes(this.projectId)) {
      throw new AuthAdapterError('invalid_grant', 'Audience do ID token inválida.');
    }
    if (audience.length > 1 && claims.azp !== this.projectId) {
      throw new AuthAdapterError('invalid_grant', 'Authorized party do ID token inválido.');
    }
    if (claims.azp !== undefined && claims.azp !== this.projectId) {
      throw new AuthAdapterError('invalid_grant', 'Authorized party do ID token inválido.');
    }
    if (claims.nonce !== expectedNonce) {
      throw new AuthAdapterError('invalid_grant', 'Nonce do ID token inválido.');
    }
    return verified.subject;
  }

  private async verifySessionJwt(token: string): Promise<{ subject: string; expiresAt: number }> {
    const verified = await this.verifySignedJwt(token, 'Session JWT');
    if (!isSupportedIssuer(verified.claims.iss, this.projectId)) {
      throw new AuthAdapterError('invalid_grant', 'Issuer do Session JWT inválido.');
    }
    return {
      subject: verified.subject,
      expiresAt: verified.expiresAt,
    };
  }

  private async verifySignedJwt(
    token: string,
    label: string,
  ): Promise<{ claims: JwtClaims; subject: string; expiresAt: number }> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw new AuthAdapterError('invalid_grant', `${label} malformado.`);
    }

    const headerSource = parseJwtObject<Record<string, unknown>>(parts[0], `Header do ${label}`);
    const claimsSource = parseJwtObject<Record<string, unknown>>(parts[1], `Payload do ${label}`);
    const header: JwtHeader = {
      alg: requiredString(headerSource.alg, `Algoritmo do ${label}`, 32),
      kid: requiredString(headerSource.kid, `Key ID do ${label}`, 512),
    };
    if (header.alg !== 'RS256') {
      throw new AuthAdapterError('invalid_grant', `Algoritmo do ${label} não permitido.`);
    }

    let keys = await this.jwks();
    let jwk = keys.find((candidate) =>
      candidate.kid === header.kid
      && (!candidate.alg || candidate.alg === 'RS256')
      && (!candidate.use || candidate.use === 'sig'));

    if (!jwk) {
      this.jwksCache = undefined;
      keys = await this.jwks();
      jwk = keys.find((candidate) =>
        candidate.kid === header.kid
        && (!candidate.alg || candidate.alg === 'RS256')
        && (!candidate.use || candidate.use === 'sig'));
    }
    if (!jwk) {
      throw new AuthAdapterError('invalid_grant', `Chave de assinatura do ${label} não encontrada.`);
    }

    let publicKey: crypto.KeyObject;
    try {
      publicKey = crypto.createPublicKey({
        key: {
          kty: 'RSA',
          n: jwk.n,
          e: jwk.e,
          ...(jwk.alg ? { alg: jwk.alg } : {}),
          ...(jwk.use ? { use: jwk.use } : {}),
          kid: jwk.kid,
        },
        format: 'jwk',
      });
    } catch {
      throw new AuthAdapterError('invalid_grant', `Chave pública do ${label} inválida.`);
    }

    const signatureValid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!signatureValid) {
      throw new AuthAdapterError('invalid_grant', `Assinatura do ${label} inválida.`);
    }

    const claims: JwtClaims = {
      iss: requiredString(claimsSource.iss, `Issuer do ${label}`, 2_048),
      sub: requiredString(claimsSource.sub, `Subject do ${label}`, 512),
      exp: parseNumericClaim(claimsSource.exp, 'Expiração'),
      ...(claimsSource.iat !== undefined ? { iat: parseNumericClaim(claimsSource.iat, 'Emissão') } : {}),
      ...(typeof claimsSource.aud === 'string' || Array.isArray(claimsSource.aud)
        ? { aud: claimsSource.aud as string | string[] }
        : {}),
      ...(typeof claimsSource.nonce === 'string' ? { nonce: claimsSource.nonce } : {}),
      ...(typeof claimsSource.azp === 'string' ? { azp: claimsSource.azp } : {}),
    };

    const nowSeconds = Math.floor(this.now() / 1_000);
    if (claims.exp <= nowSeconds - 60) {
      throw new AuthAdapterError('expired', `${label} expirado.`);
    }
    if (claims.iat !== undefined && claims.iat > nowSeconds + 300) {
      throw new AuthAdapterError('invalid_grant', `${label} emitido no futuro.`);
    }

    return {
      claims,
      subject: claims.sub,
      expiresAt: claims.exp * 1_000,
    };
  }

  private async jwks(): Promise<CachedJwks['keys']> {
    const now = this.now();
    if (this.jwksCache && this.jwksCache.expiresAt > now) return this.jwksCache.keys;

    const source = readJsonObject(
      await this.jsonRequest(`/${encodeURIComponent(this.projectId)}/.well-known/jwks.json`, {}),
      'JWKS',
    );
    if (!Array.isArray(source.keys)) {
      throw new AuthAdapterError('server', 'JWKS inválido retornado pelo serviço de identidade.');
    }

    const keys: CachedJwks['keys'] = [];
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
    if (keys.length === 0) {
      throw new AuthAdapterError('server', 'Nenhuma chave RSA válida encontrada no JWKS.');
    }

    this.jwksCache = { expiresAt: now + 5 * 60 * 1000, keys };
    return keys;
  }

  private endpoint(pathname: string): URL {
    return new URL(pathname, this.origin + '/');
  }

  private async descopeRequest(
    url: URL,
    init: RequestInit,
    refreshToken?: string,
    allowEmpty = false,
  ): Promise<unknown> {
    const authorization = refreshToken
      ? `Bearer ${this.projectId}:${refreshToken}`
      : `Bearer ${this.projectId}`;
    return await this.request(url, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization,
        'x-descope-project-id': this.projectId,
      },
    }, allowEmpty);
  }

  private async formRequest(pathname: string, body: URLSearchParams, allowEmpty = false): Promise<unknown> {
    return await this.request(this.endpoint(pathname), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    }, allowEmpty);
  }

  private async jsonRequest(pathname: string, headers: Record<string, string>): Promise<unknown> {
    return await this.request(this.endpoint(pathname), {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
    });
  }

  private async request(url: URL, init: RequestInit, allowEmpty = false): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });

      let payload: unknown = null;
      if (response.status !== 204) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('application/json')) {
          payload = await response.json();
        } else if (!allowEmpty) {
          throw new AuthAdapterError('server', 'Resposta não JSON do serviço de identidade.');
        }
      }

      if (!response.ok) {
        const source = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {};
        const code = optionalString(source.error, 256)
          || optionalString(source.errorCode, 256)
          || '';
        const description = optionalString(source.error_description, 2_048)
          || optionalString(source.errorDescription, 2_048)
          || optionalString(source.errorMessage, 2_048)
          || 'Falha no serviço de identidade.';

        if (
          code === 'invalid_grant'
          || response.status === 401
          || response.status === 403
        ) {
          throw new AuthAdapterError('invalid_grant', description);
        }
        throw new AuthAdapterError('server', description);
      }

      return payload;
    } catch (error) {
      if (error instanceof AuthAdapterError) throw error;
      if (controller.signal.aborted) {
        throw new AuthAdapterError('offline', 'Tempo limite ao conectar ao serviço de identidade.');
      }
      throw new AuthAdapterError('offline', 'Não foi possível conectar ao serviço de identidade.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
