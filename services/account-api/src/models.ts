export type IdentityProvider = 'google' | 'github' | 'microsoft' | 'passkey' | 'magic_link';

export type BrowserUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

export type DesktopAccount = {
  id: string;
  primaryEmail: string;
  displayName: string;
  username?: string;
  avatarUrl?: string;
  status: 'active' | 'disabled' | 'pending_deletion';
  identities: Array<{
    id: string;
    provider: IdentityProvider;
    providerAccountId: string;
    email?: string;
    displayName?: string;
    avatarUrl?: string;
    linkedAt: number;
    lastUsedAt?: number;
  }>;
  createdAt: number;
  updatedAt: number;
};

export type DesktopSession = {
  id: string;
  accountId: string;
  deviceId: string;
  identityProvider: IdentityProvider;
  createdAt: number;
  lastActivityAt: number;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  revokedAt?: number;
};

export type AuthGrant = {
  account: DesktopAccount;
  session: DesktopSession;
  accessToken: string;
  refreshToken: string;
};
