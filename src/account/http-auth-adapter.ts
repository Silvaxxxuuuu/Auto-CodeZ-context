import type {
  AccountProfile,
  AccountSession,
  IdentityProvider,
  LinkedIdentity,
} from './types';
import {
  AuthAdapterError,
  type AuthAdapter,
  type AuthAdapterErrorCode,
  type AuthGrant,
  type BeginMagicLinkInput,
  type BeginOAuthInput,
  type BeginPasskeyInput,
  type CompleteMagicLinkInput,
  type CompleteOAuthInput,
  type CompletePasskeyInput,
  type RefreshSessionInput,
  type RevokeSessionInput,
} from './auth-adapter';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface HttpAuthAdapterOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthAdapterError('server', `${label} inválido retornado pelo serviço de autenticação.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 16_384): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new AuthAdapterError('server', `${label} inválido retornado pelo serviço de autenticação.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, max = 16_384): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, label, max);
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuthAdapterError('server', `${label} inválido retornado pelo serviço de autenticação.`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return numberValue(value, label);
}

function identityProvider(value: unknown): IdentityProvider {
  const provider = stringValue(value, 'Provider');
  if (
    provider !== 'google'
    && provider !== 'github'
    && provider !== 'microsoft'
    && provider !== 'passkey'
    && provider !== 'magic_link'
  ) {
    throw new AuthAdapterError('server', 'Provider inválido retornado pelo serviço de autenticação.');
  }
  return provider;
}

function parseIdentity(value: unknown): LinkedIdentity {
  const source = objectValue(value, 'Identidade vinculada');
  return {
    id: stringValue(source.id, 'ID da identidade', 256),
    provider: identityProvider(source.provider),
    providerAccountId: stringValue(source.providerAccountId, 'Conta do provider', 512),
    email: optionalString(source.email, 'E-mail da identidade', 254),
    displayName: optionalString(source.displayName, 'Nome da identidade', 256),
    avatarUrl: optionalString(source.avatarUrl, 'Avatar da identidade', 2_048),
    linkedAt: numberValue(source.linkedAt, 'Data de vínculo'),
    lastUsedAt: optionalNumber(source.lastUsedAt, 'Último uso'),
  };
}

function parseProfile(value: unknown): AccountProfile {
  const source = objectValue(value, 'Conta');
  const status = stringValue(source.status, 'Status da conta', 64);
  if (status !== 'active' && status !== 'disabled' && status !== 'pending_deletion') {
    throw new AuthAdapterError('server', 'Status de conta inválido retornado pelo serviço de autenticação.');
  }
  if (!Array.isArray(source.identities)) {
    throw new AuthAdapterError('server', 'Identidades inválidas retornadas pelo serviço de autenticação.');
  }
  return {
    id: stringValue(source.id, 'ID da conta', 256),
    primaryEmail: stringValue(source.primaryEmail, 'E-mail principal', 254),
    displayName: stringValue(source.displayName, 'Nome da conta', 256),
    username: optionalString(source.username, 'Username', 128),
    avatarUrl: optionalString(source.avatarUrl, 'Avatar', 2_048),
    status,
    identities: source.identities.map(parseIdentity),
    createdAt: numberValue(source.createdAt, 'Data de criação da conta'),
    updatedAt: numberValue(source.updatedAt, 'Data de atualização da conta'),
  };
}

function parseSession(value: unknown): AccountSession {
  const source = objectValue(value, 'Sessão');
  return {
    id: stringValue(source.id, 'ID da sessão', 256),
    accountId: stringValue(source.accountId, 'ID da conta da sessão', 256),
    deviceId: stringValue(source.deviceId, 'ID do dispositivo da sessão', 256),
    identityProvider: identityProvider(source.identityProvider),
    createdAt: numberValue(source.createdAt, 'Data de criação da sessão'),
    lastActivityAt: numberValue(source.lastActivityAt, 'Última atividade da sessão'),
    accessExpiresAt: numberValue(source.accessExpiresAt, 'Expiração do access token'),
    refreshExpiresAt: optionalNumber(source.refreshExpiresAt, 'Expiração do refresh token'),
    revokedAt: optionalNumber(source.revokedAt, 'Data de revogação'),
  };
}

function parseGrant(value: unknown): AuthGrant {
  const source = objectValue(value, 'Grant de autenticação');
  return {
    account: parseProfile(source.account),
    session: parseSession(source.session),
    accessToken: stringValue(source.accessToken, 'Access token', 32_768),
    refreshToken: stringValue(source.refreshToken, 'Refresh token', 32_768),
  };
}

function mapRemoteError(status: number, payload: unknown): AuthAdapterError {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const remoteCode = typeof source.code === 'string' ? source.code : '';
  const message = typeof source.message === 'string' && source.message
    ? source.message
    : 'Falha no serviço de autenticação.';

  const code: AuthAdapterErrorCode = remoteCode === 'revoked'
    ? 'revoked'
    : remoteCode === 'invalid_grant' || status === 401
      ? 'invalid_grant'
      : remoteCode === 'expired'
        ? 'expired'
        : remoteCode === 'cancelled'
          ? 'cancelled'
          : remoteCode === 'not_configured'
            ? 'not_configured'
            : 'server';

  return new AuthAdapterError(code, message);
}

export class HttpAuthAdapter implements AuthAdapter {
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: HttpAuthAdapterOptions = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('O serviço de autenticação precisa usar HTTPS.');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('URL do serviço de autenticação inválida.');
    }
    this.origin = parsed.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) {
      throw new Error('Timeout do serviço de autenticação inválido.');
    }
  }

  async refresh(input: RefreshSessionInput): Promise<AuthGrant> {
    return parseGrant(await this.post('/v1/auth/session/refresh', input));
  }

  async revoke(input: RevokeSessionInput): Promise<void> {
    await this.post('/v1/auth/session/revoke', input);
  }

  async beginOAuth(input: BeginOAuthInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    const source = objectValue(await this.post('/v1/auth/oauth/begin', input), 'Início OAuth');
    const authorizationUrl = stringValue(source.authorizationUrl, 'URL de autorização', 4_096);
    const parsed = new URL(authorizationUrl);
    if (parsed.protocol !== 'https:') {
      throw new AuthAdapterError('server', 'URL OAuth insegura retornada pelo serviço de autenticação.');
    }
    return {
      authorizationUrl,
      flowId: stringValue(source.flowId, 'ID do fluxo OAuth', 256),
      expiresAt: numberValue(source.expiresAt, 'Expiração do fluxo OAuth'),
    };
  }

  async completeOAuth(input: CompleteOAuthInput): Promise<AuthGrant> {
    return parseGrant(await this.post('/v1/auth/oauth/complete', input));
  }

  async beginMagicLink(input: BeginMagicLinkInput): Promise<{ flowId: string; expiresAt: number }> {
    const source = objectValue(await this.post('/v1/auth/magic-link/begin', input), 'Início do Magic Link');
    return {
      flowId: stringValue(source.flowId, 'ID do Magic Link', 256),
      expiresAt: numberValue(source.expiresAt, 'Expiração do Magic Link'),
    };
  }

  async completeMagicLink(input: CompleteMagicLinkInput): Promise<AuthGrant> {
    return parseGrant(await this.post('/v1/auth/magic-link/complete', input));
  }

  async beginPasskey(input: BeginPasskeyInput): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    const source = objectValue(await this.post('/v1/auth/passkey/begin', input), 'Início da Passkey');
    const authorizationUrl = stringValue(source.authorizationUrl, 'URL da Passkey', 4_096);
    const parsed = new URL(authorizationUrl);
    if (parsed.protocol !== 'https:') {
      throw new AuthAdapterError('server', 'URL Passkey insegura retornada pelo serviço de autenticação.');
    }
    return {
      authorizationUrl,
      flowId: stringValue(source.flowId, 'ID do fluxo Passkey', 256),
      expiresAt: numberValue(source.expiresAt, 'Expiração do fluxo Passkey'),
    };
  }

  async completePasskey(input: CompletePasskeyInput): Promise<AuthGrant> {
    return parseGrant(await this.post('/v1/auth/passkey/complete', input));
  }

  private async post(pathname: string, body: unknown): Promise<unknown> {
    const url = new URL(pathname, this.origin);
    if (url.origin !== this.origin) throw new Error('Endpoint de autenticação inválido.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') ?? '';
      let payload: unknown = null;
      if (contentType.toLowerCase().includes('application/json')) {
        payload = await response.json();
      } else if (response.status !== 204) {
        throw new AuthAdapterError('server', 'Resposta não JSON do serviço de autenticação.');
      }

      if (!response.ok) throw mapRemoteError(response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof AuthAdapterError) throw error;
      if (controller.signal.aborted) {
        throw new AuthAdapterError('offline', 'Tempo limite ao conectar ao serviço de autenticação.');
      }
      throw new AuthAdapterError('offline', 'Não foi possível conectar ao serviço de autenticação.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
