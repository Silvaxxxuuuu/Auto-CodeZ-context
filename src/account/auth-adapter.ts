import type {
  AccountProfile,
  AccountSession,
  DeviceId,
  IdentityProvider,
} from './types';

export type AuthAdapterErrorCode =
  | 'offline'
  | 'revoked'
  | 'invalid_grant'
  | 'server'
  | 'cancelled';

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
  provider: Extract<IdentityProvider, 'github' | 'google' | 'microsoft'>;
  deviceId: DeviceId;
}

export interface BeginMagicLinkInput {
  email: string;
  deviceId: DeviceId;
}

export interface CompleteMagicLinkInput {
  flowId: string;
  token: string;
  deviceId: DeviceId;
}

export interface BeginPasskeyInput {
  deviceId: DeviceId;
}

export interface AuthAdapter {
  refresh(input: RefreshSessionInput): Promise<AuthGrant>;
  revoke(input: RevokeSessionInput): Promise<void>;

  beginOAuth?(input: BeginOAuthInput): Promise<{ authorizationUrl: string; flowId: string }>;
  beginMagicLink?(input: BeginMagicLinkInput): Promise<{ flowId: string; expiresAt: number }>;
  completeMagicLink?(input: CompleteMagicLinkInput): Promise<AuthGrant>;
  beginPasskey?(input: BeginPasskeyInput): Promise<AuthGrant>;
}

export class UnavailableAuthAdapter implements AuthAdapter {
  async refresh(): Promise<AuthGrant> {
    throw new AuthAdapterError('offline', 'Serviço de autenticação ainda não está configurado.');
  }

  async revoke(): Promise<void> {
  }
}
