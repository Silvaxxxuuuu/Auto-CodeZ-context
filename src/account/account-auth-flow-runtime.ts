import crypto from 'node:crypto';
import type { AuthAdapter, AuthGrant, OAuthProvider } from './auth-adapter';
import { AuthAdapterError } from './auth-adapter';
import { AccountSessionRuntime } from './account-session-runtime';
import { DeviceIdentityStore } from './device-identity';
import type { ProtectedCredentialStore } from './protected-credential-store';

export type AuthFlowStatus =
  | 'idle'
  | 'waiting_magic_link'
  | 'waiting_browser'
  | 'completing'
  | 'authenticated'
  | 'error';

export type AuthFlowMethod = 'magic_link' | 'oauth' | 'passkey' | 'hosted';

export interface AuthFlowSnapshot {
  status: AuthFlowStatus;
  method?: AuthFlowMethod;
  provider?: OAuthProvider;
  flowId?: string;
  emailHint?: string;
  expiresAt?: number;
  lastError?: string;
}

interface PendingOAuthFlow {
  flowId: string;
  provider: OAuthProvider;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

interface PendingMagicLinkFlow {
  flowId: string;
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

interface PendingPasskeyFlow {
  flowId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

interface PendingHostedFlow {
  flowId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('E-mail inválido.');
  }
  return normalized;
}

function emailHint(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visibleLocal = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visibleLocal}${'*'.repeat(Math.max(2, local.length - visibleLocal.length))}@${domain}`;
}

const PENDING_HOSTED_CREDENTIAL = 'account.auth.pending-hosted';

function cloneSnapshot(snapshot: AuthFlowSnapshot): AuthFlowSnapshot {
  return { ...snapshot };
}

export class AccountAuthFlowRuntime {
  private snapshotState: AuthFlowSnapshot = { status: 'idle' };
  private pendingOAuth?: PendingOAuthFlow;
  private pendingMagicLink?: PendingMagicLinkFlow;
  private pendingPasskey?: PendingPasskeyFlow;
  private pendingHosted?: PendingHostedFlow;
  private readonly listeners = new Set<(snapshot: AuthFlowSnapshot) => void>();

  constructor(
    private readonly auth: AuthAdapter,
    private readonly sessions: AccountSessionRuntime,
    private readonly devices: DeviceIdentityStore,
    private readonly now: () => number = Date.now,
    private readonly pendingCredentials?: ProtectedCredentialStore,
  ) {}

  snapshot(): AuthFlowSnapshot {
    return cloneSnapshot(this.snapshotState);
  }

  subscribe(listener: (snapshot: AuthFlowSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): AuthFlowSnapshot {
    this.pendingOAuth = undefined;
    this.pendingMagicLink = undefined;
    this.pendingPasskey = undefined;
    this.pendingHosted = undefined;
    return this.setState({ status: 'idle' });
  }

  async beginMagicLink(email: string): Promise<AuthFlowSnapshot> {
    this.assertCanBegin();
    const normalizedEmail = normalizeEmail(email);
    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      const result = await this.auth.beginMagicLink({
        email: normalizedEmail,
        deviceId: device.id,
        state,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      this.pendingMagicLink = {
        flowId: result.flowId,
        state,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.pendingOAuth = undefined;
      this.pendingPasskey = undefined;
      this.pendingHosted = undefined;

      return this.setState({
        status: 'waiting_magic_link',
        method: 'magic_link',
        flowId: result.flowId,
        emailHint: emailHint(normalizedEmail),
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      return this.fail(error);
    }
  }

  async completeMagicLink(input: {
    flowId: string;
    token: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    const pending = this.pendingMagicLink;
    if (!pending || pending.flowId !== input.flowId) throw new Error('Fluxo de Magic Link inválido.');
    this.assertNotExpired(pending.expiresAt);

    if (input.state !== pending.state) {
      this.clearPending();
      return this.setState({
        status: 'error',
        method: 'magic_link',
        lastError: 'Estado Magic Link inválido.',
      });
    }

    const value = input.token.trim();
    if (!value || value.length > 16_384) throw new Error('Token de Magic Link inválido.');

    const device = await this.requirePersistentDevice();
    this.setState({
      status: 'completing',
      method: 'magic_link',
      flowId: pending.flowId,
      expiresAt: pending.expiresAt,
    });

    try {
      const grant = await this.auth.completeMagicLink({
        flowId: pending.flowId,
        token: value,
        deviceId: device.id,
        state: pending.state,
        codeVerifier: pending.codeVerifier,
      });
      return await this.finishGrant(grant);
    } catch (error) {
      return this.fail(error);
    }
  }

  async beginOAuth(provider: OAuthProvider): Promise<{
    snapshot: AuthFlowSnapshot;
    authorizationUrl: string;
  }> {
    this.assertCanBegin();
    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      const result = await this.auth.beginOAuth({
        provider,
        deviceId: device.id,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      this.pendingOAuth = {
        flowId: result.flowId,
        provider,
        state,
        nonce,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.pendingMagicLink = undefined;
      this.pendingPasskey = undefined;
      this.pendingHosted = undefined;

      return {
        snapshot: this.setState({
          status: 'waiting_browser',
          method: 'oauth',
          provider,
          flowId: result.flowId,
          expiresAt: result.expiresAt,
        }),
        authorizationUrl: result.authorizationUrl,
      };
    } catch (error) {
      return {
        snapshot: this.fail(error),
        authorizationUrl: '',
      };
    }
  }

  async completeOAuth(input: {
    flowId: string;
    code: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    const pending = this.pendingOAuth;
    if (!pending || pending.flowId !== input.flowId) throw new Error('Fluxo OAuth inválido.');
    this.assertNotExpired(pending.expiresAt);

    if (input.state !== pending.state) {
      this.clearPending();
      return this.setState({
        status: 'error',
        method: 'oauth',
        provider: pending.provider,
        lastError: 'Estado OAuth inválido.',
      });
    }

    const code = input.code.trim();
    if (!code || code.length > 16_384) throw new Error('Código OAuth inválido.');
    const device = await this.requirePersistentDevice();

    this.setState({
      status: 'completing',
      method: 'oauth',
      provider: pending.provider,
      flowId: pending.flowId,
      expiresAt: pending.expiresAt,
    });

    try {
      const grant = await this.auth.completeOAuth({
        flowId: pending.flowId,
        provider: pending.provider,
        deviceId: device.id,
        code,
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      });
      return await this.finishGrant(grant);
    } catch (error) {
      return this.fail(error);
    }
  }

  async beginPasskey(): Promise<{
    snapshot: AuthFlowSnapshot;
    authorizationUrl: string;
  }> {
    this.assertCanBegin();
    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      const result = await this.auth.beginPasskey({
        deviceId: device.id,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });
      this.pendingPasskey = {
        flowId: result.flowId,
        state,
        nonce,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.pendingOAuth = undefined;
      this.pendingMagicLink = undefined;
      this.pendingHosted = undefined;

      return {
        snapshot: this.setState({
          status: 'waiting_browser',
          method: 'passkey',
          flowId: result.flowId,
          expiresAt: result.expiresAt,
        }),
        authorizationUrl: result.authorizationUrl,
      };
    } catch (error) {
      return {
        snapshot: this.fail(error),
        authorizationUrl: '',
      };
    }
  }

  async completePasskey(input: {
    flowId: string;
    code: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    const pending = this.pendingPasskey;
    if (!pending || pending.flowId !== input.flowId) throw new Error('Fluxo Passkey inválido.');
    this.assertNotExpired(pending.expiresAt);

    if (input.state !== pending.state) {
      this.clearPending();
      return this.setState({
        status: 'error',
        method: 'passkey',
        lastError: 'Estado Passkey inválido.',
      });
    }

    const code = input.code.trim();
    if (!code || code.length > 16_384) throw new Error('Código Passkey inválido.');
    const device = await this.requirePersistentDevice();

    this.setState({
      status: 'completing',
      method: 'passkey',
      flowId: pending.flowId,
      expiresAt: pending.expiresAt,
    });

    try {
      const grant = await this.auth.completePasskey({
        flowId: pending.flowId,
        deviceId: device.id,
        code,
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      });
      return await this.finishGrant(grant);
    } catch (error) {
      return this.fail(error);
    }
  }

  async beginHosted(): Promise<{
    snapshot: AuthFlowSnapshot;
    authorizationUrl: string;
  }> {
    this.assertCanBegin();
    const begin = this.auth.beginHosted;
    if (!begin) {
      return {
        snapshot: this.fail(new AuthAdapterError('not_configured', 'Login hospedado não está configurado.')),
        authorizationUrl: '',
      };
    }

    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      const result = await begin.call(this.auth, {
        deviceId: device.id,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      this.pendingHosted = {
        flowId: result.flowId,
        state,
        nonce,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      await this.persistPendingHosted(this.pendingHosted);
      this.pendingOAuth = undefined;
      this.pendingMagicLink = undefined;
      this.pendingPasskey = undefined;

      return {
        snapshot: this.setState({
          status: 'waiting_browser',
          method: 'hosted',
          flowId: result.flowId,
          expiresAt: result.expiresAt,
        }),
        authorizationUrl: result.authorizationUrl,
      };
    } catch (error) {
      return {
        snapshot: this.fail(error),
        authorizationUrl: '',
      };
    }
  }

  async completeHosted(input: {
    code: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    const pending = this.pendingHosted ?? await this.restorePendingHosted();
    if (!pending) throw new Error('Fluxo hospedado inválido ou expirado.');
    try {
      this.assertNotExpired(pending.expiresAt);
    } catch (error) {
      await this.clearPersistedHosted();
      throw error;
    }

    if (input.state !== pending.state) {
      this.clearPending();
      await this.clearPersistedHosted();
      return this.setState({
        status: 'error',
        method: 'hosted',
        lastError: 'Estado de autenticação inválido.',
      });
    }

    const complete = this.auth.completeHosted;
    if (!complete) throw new AuthAdapterError('not_configured', 'Login hospedado não está configurado.');

    const code = input.code.trim();
    if (!code || code.length > 16_384) throw new Error('Código de autenticação inválido.');
    const device = await this.requirePersistentDevice();

    this.setState({
      status: 'completing',
      method: 'hosted',
      flowId: pending.flowId,
      expiresAt: pending.expiresAt,
    });

    try {
      const grant = await complete.call(this.auth, {
        flowId: pending.flowId,
        deviceId: device.id,
        code,
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      });
      await this.clearPersistedHosted();
      return await this.finishGrant(grant);
    } catch (error) {
      await this.clearPersistedHosted();
      return this.fail(error);
    }
  }

  async failHostedCallback(input: {
    error: string;
    errorDescription?: string;
    state?: string;
  }): Promise<AuthFlowSnapshot> {
    const pending = this.pendingHosted ?? await this.restorePendingHosted();
    if (pending && input.state && input.state !== pending.state) {
      this.clearPending();
      await this.clearPersistedHosted();
      return this.setState({
        status: 'error',
        method: 'hosted',
        lastError: 'Estado de autenticação inválido.',
      });
    }

    this.clearPending();
    await this.clearPersistedHosted();
    const cancelled = input.error === 'access_denied' || input.error === 'cancelled';
    const safeDescription = input.errorDescription?.trim().slice(0, 512);
    return this.setState({
      status: 'error',
      method: 'hosted',
      lastError: cancelled
        ? 'Autenticação cancelada.'
        : safeDescription || 'Não foi possível concluir a autenticação.',
    });
  }

  private async persistPendingHosted(pending: PendingHostedFlow): Promise<void> {
    if (!this.pendingCredentials) return;
    await this.pendingCredentials.set(PENDING_HOSTED_CREDENTIAL, JSON.stringify(pending));
  }

  private async restorePendingHosted(): Promise<PendingHostedFlow | undefined> {
    if (!this.pendingCredentials) return undefined;
    const raw = await this.pendingCredentials.get(PENDING_HOSTED_CREDENTIAL);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as Partial<PendingHostedFlow>;
      if (
        typeof value.flowId !== 'string' || !value.flowId
        || typeof value.state !== 'string' || !value.state
        || typeof value.nonce !== 'string' || !value.nonce
        || typeof value.codeVerifier !== 'string' || value.codeVerifier.length < 40
        || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
        || value.expiresAt <= this.now()
      ) {
        await this.clearPersistedHosted();
        return undefined;
      }
      const restored: PendingHostedFlow = {
        flowId: value.flowId,
        state: value.state,
        nonce: value.nonce,
        codeVerifier: value.codeVerifier,
        expiresAt: value.expiresAt,
      };
      this.pendingHosted = restored;
      return restored;
    } catch {
      await this.clearPersistedHosted();
      return undefined;
    }
  }

  private async clearPersistedHosted(): Promise<void> {
    if (!this.pendingCredentials) return;
    await this.pendingCredentials.remove(PENDING_HOSTED_CREDENTIAL);
  }

  private async finishGrant(grant: AuthGrant): Promise<AuthFlowSnapshot> {
    await this.sessions.establish(grant);
    this.clearPending();
    return this.setState({ status: 'authenticated' });
  }

  private async requirePersistentDevice() {
    const device = await this.devices.getOrCreate();
    if (device.credentialPersistence !== 'protected') {
      throw new Error('Armazenamento seguro do sistema indisponível para autenticação persistente.');
    }
    return device;
  }

  private assertCanBegin(): void {
    if (this.snapshotState.status === 'completing') {
      throw new Error('Uma autenticação já está sendo concluída.');
    }
  }

  private assertNotExpired(expiresAt: number): void {
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.clearPending();
      this.setState({ status: 'error', lastError: 'Fluxo de autenticação expirado.' });
      throw new AuthAdapterError('expired', 'Fluxo de autenticação expirado.');
    }
  }

  private fail(error: unknown): AuthFlowSnapshot {
    const message = error instanceof Error ? error.message : 'Falha na autenticação.';
    this.clearPending();
    return this.setState({
      status: 'error',
      lastError: message,
    });
  }

  private clearPending(): void {
    this.pendingOAuth = undefined;
    this.pendingMagicLink = undefined;
    this.pendingPasskey = undefined;
    this.pendingHosted = undefined;
  }

  private setState(snapshot: AuthFlowSnapshot): AuthFlowSnapshot {
    this.snapshotState = cloneSnapshot(snapshot);
    const current = this.snapshot();
    for (const listener of this.listeners) listener(current);
    return current;
  }
}
