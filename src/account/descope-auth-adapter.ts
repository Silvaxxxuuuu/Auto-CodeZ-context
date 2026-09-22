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
  type RefreshSessionInput,
  type RevokeSessionInput,
} from './auth-adapter';
import type { AccountProfile, AccountSession, DeviceId } from './types';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DescopeAuthAdapterOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

type TokenResponse = {
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

function parseTokenResponse(value: unknown, fallbackRefreshToken?: string): TokenResponse {
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

function sessionId(refreshToken: string): string {
  return crypto.createHash('sha256').update(refreshToken, 'utf8').digest('hex').slice(0, 40);
}

export class DescopeAuthAdapter implements AuthAdapter {
  private readonly projectId: string;
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly redirectUri = 'autocodez://auth/hosted';

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
    return this.beginHostedFlow(input.state, input.nonce, input.codeChallenge);
  }

  async completeHosted(input: CompleteHostedInput): Promise<AuthGrant> {
    return await this.completeHostedFlow(input.flowId, input.deviceId, input.code, input.codeVerifier);
  }

  async beginOAuth(input: BeginOAuthInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    return this.beginHostedFlow(input.state, input.nonce, input.codeChallenge);
  }

  async completeOAuth(input: CompleteOAuthInput): Promise<AuthGrant> {
    return await this.completeHostedFlow(input.flowId, input.deviceId, input.code, input.codeVerifier);
  }

  async beginMagicLink(_input: BeginMagicLinkInput): Promise<{ flowId: string; expiresAt: number }> {
    throw new AuthAdapterError(
      'not_configured',
      'Magic Link é oferecido pelo login hospedado do Auto CodeZ.',
    );
  }

  async completeMagicLink(_input: CompleteMagicLinkInput): Promise<AuthGrant> {
    throw new AuthAdapterError('invalid_grant', 'Fluxo Magic Link legado não é aceito.');
  }

  async beginPasskey(input: BeginPasskeyInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    return this.beginHostedFlow(input.state, input.nonce, input.codeChallenge);
  }

  async completePasskey(input: CompletePasskeyInput): Promise<AuthGrant> {
    return await this.completeHostedFlow(input.flowId, input.deviceId, input.code, input.codeVerifier);
  }

  async refresh(input: RefreshSessionInput): Promise<AuthGrant> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.projectId,
      refresh_token: input.refreshToken,
    });
    const tokens = parseTokenResponse(
      await this.formRequest('/oauth2/v1/token', body),
      input.refreshToken,
    );
    return await this.grantFromTokens(tokens, input.deviceId);
  }

  async revoke(input: RevokeSessionInput): Promise<void> {
    if (!input.refreshToken) return;
    const body = new URLSearchParams({
      token: input.refreshToken,
      client_id: this.projectId,
    });
    await this.formRequest('/oauth2/v1/revoke', body, true);
  }

  private beginHostedFlow(state: string, nonce: string, codeChallenge: string): {
    authorizationUrl: string;
    flowId: string;
    expiresAt: number;
  } {
    const flowId = crypto.randomUUID();
    const redirectUri = this.redirectUri;

    const url = this.endpoint('/oauth2/v1/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.projectId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);

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
  ): Promise<AuthGrant> {
    if (!flowId.trim()) throw new AuthAdapterError('invalid_grant', 'Fluxo de autenticação não encontrado.');
    const redirectUri = this.redirectUri;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.projectId,
      code_verifier: codeVerifier,
    });
    const tokens = parseTokenResponse(await this.formRequest('/oauth2/v1/token', body));
    if (!tokens.refresh_token) {
      throw new AuthAdapterError('server', 'O serviço de identidade não retornou refresh token.');
    }
    return await this.grantFromTokens(tokens, deviceId);
  }

  private async grantFromTokens(tokens: TokenResponse, deviceId: DeviceId): Promise<AuthGrant> {
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new AuthAdapterError('server', 'Refresh token ausente.');

    const user = parseUserInfo(await this.jsonRequest('/oauth2/v1/userinfo', {
      authorization: `Bearer ${tokens.access_token}`,
    }));
    const now = this.now();
    const expiresAt = now + Math.max(60, tokens.expires_in ?? 3_600) * 1000;

    const identity = {
      id: `descope:${user.sub}`,
      provider: 'descope' as const,
      providerAccountId: user.sub,
      email: user.email,
      displayName: user.name || user.preferred_username || user.email,
      ...(user.picture ? { avatarUrl: user.picture } : {}),
      linkedAt: now,
      lastUsedAt: now,
    };

    const account: AccountProfile = {
      id: user.sub,
      primaryEmail: user.email,
      displayName: user.name || user.preferred_username || user.email.split('@')[0] || 'Auto CodeZ User',
      ...(user.preferred_username ? { username: user.preferred_username } : {}),
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
      identityProvider: 'descope',
      createdAt: now,
      lastActivityAt: now,
      accessExpiresAt: expiresAt,
    };

    return {
      account,
      session,
      accessToken: tokens.access_token,
      refreshToken,
    };
  }

  private endpoint(pathname: string): URL {
    return new URL(pathname, this.origin + '/');
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
        const code = typeof source.error === 'string' ? source.error : '';
        const description = typeof source.error_description === 'string'
          ? source.error_description
          : 'Falha no serviço de identidade.';
        if (code === 'invalid_grant' || response.status === 401) {
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
