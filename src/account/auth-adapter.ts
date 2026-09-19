import type {
  AccountProfile,
  AccountSession,
  DeviceId,
  IdentityProvider,
} from './types';

export type OAuthProvider = Extract<IdentityProvider, 'github' | 'google' | 'microsoft'>;

export type AuthAdapterErrorCode =
  | 'offline'
  | 'revoked'
  | 'invalid_grant'
  | 'expired'
  | 'server'
  | 'cancelled'
  | 'not_configured';

export class AuthAdapterError extends Error {
  constructor(
    public readonly code: AuthAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthAdapterError';
  }
}

export interface AuthGrant {
  account: AccountProfile;
  session: AccountSession;
  accessToken: string;
  refreshToken: string;
}

export interface RefreshSessionInput {
  refreshToken: string;
  deviceId: DeviceId;
}

export interface RevokeSessionInput {
  sessionId: string;
  refreshToken?: string;
  deviceId: DeviceId;
}

export interface BeginOAuthInput {
  provider: OAuthProvider;
  deviceId: DeviceId;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface CompleteOAuthInput {
  flowId: string;
  provider: OAuthProvider;
  deviceId: DeviceId;
  code: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface BeginMagicLinkInput {
  email: string;
  deviceId: DeviceId;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface CompleteMagicLinkInput {
  flowId: string;
  token: string;
  deviceId: DeviceId;
  state: string;
  codeVerifier: string;
}

export interface BeginPasskeyInput {
  deviceId: DeviceId;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface CompletePasskeyInput {
  flowId: string;
  deviceId: DeviceId;
  code: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface SessionAuthAdapter {
  refresh(input: RefreshSessionInput): Promise<AuthGrant>;
  revoke(input: RevokeSessionInput): Promise<void>;
}

export type AuthMethod = 'magic_link' | 'github' | 'google' | 'microsoft' | 'passkey';

export interface AuthAdapter extends SessionAuthAdapter {
  configuration(): Promise<{ methods: AuthMethod[] }>;
  beginOAuth(input: BeginOAuthInput): Promise<{
    authorizationUrl: string;
    flowId: string;
    expiresAt: number;
  }>;
  completeOAuth(input: CompleteOAuthInput): Promise<AuthGrant>;

  beginMagicLink(input: BeginMagicLinkInput): Promise<{
    flowId: string;
    expiresAt: number;
  }>;
  completeMagicLink(input: CompleteMagicLinkInput): Promise<AuthGrant>;

  beginPasskey(input: BeginPasskeyInput): Promise<{
    authorizationUrl: string;
    flowId: string;
    expiresAt: number;
  }>;
  completePasskey(input: CompletePasskeyInput): Promise<AuthGrant>;
}

export class UnavailableAuthAdapter implements AuthAdapter {
  private unavailable(): never {
    throw new AuthAdapterError('not_configured', 'Serviço de autenticação ainda não está configurado.');
  }

  async configuration(): Promise<{ methods: AuthMethod[] }> {
    return { methods: [] };
  }

  async refresh(): Promise<AuthGrant> {
    return this.unavailable();
  }

  async revoke(): Promise<void> {
    return;
  }

  async beginOAuth(): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    return this.unavailable();
  }

  async completeOAuth(): Promise<AuthGrant> {
    return this.unavailable();
  }

  async beginMagicLink(): Promise<{ flowId: string; expiresAt: number }> {
    return this.unavailable();
  }

  async completeMagicLink(): Promise<AuthGrant> {
    return this.unavailable();
  }

  async beginPasskey(): Promise<{ authorizationUrl: string; flowId: string; expiresAt: number }> {
    return this.unavailable();
  }

  async completePasskey(): Promise<AuthGrant> {
    return this.unavailable();
  }
}
