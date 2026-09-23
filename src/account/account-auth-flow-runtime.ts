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

const PENDING_OAUTH_CREDENTIAL = 'account.auth.pending-oauth';
const PENDING_MAGIC_CREDENTIAL = 'account.auth.pending-magic-link';
const PENDING_PASSKEY_CREDENTIAL = 'account.auth.pending-passkey';
const PENDING_HOSTED_CREDENTIAL = 'account.auth.pending-hosted';

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

function cloneSnapshot(snapshot: AuthFlowSnapshot): AuthFlowSnapshot {
  return { ...snapshot };
}

function validBasePending(value: Record<string, unknown>, now: number): boolean {
  return typeof value.flowId === 'string'
    && value.flowId.length > 0
    && value.flowId.length <= 256
    && typeof value.state === 'string'
    && value.state.length >= 16
    && value.state.length <= 512
    && typeof value.codeVerifier === 'string'
    && value.codeVerifier.length >= 40
    && value.codeVerifier.length <= 256
    && typeof value.expiresAt === 'number'
    && Number.isFinite(value.expiresAt)
    && value.expiresAt > now;
}

export class AccountAuthFlowRuntime {
  private snapshotState: AuthFlowSnapshot = { status: 'idle' };
  private pendingOAuth?: PendingOAuthFlow;
  private pendingMagicLink?: PendingMagicLinkFlow;
  private pendingPasskey?: PendingPasskeyFlow;
  private pendingHosted?: PendingHostedFlow;
  private cleanupPromise: Promise<void> = Promise.resolve();
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
    this.clearPending();
    this.schedulePersistedCleanup();
    return this.setState({ status: 'idle' });
  }

  async cancel(): Promise<AuthFlowSnapshot> {
    this.clearPending();
    await this.cleanupPromise;
    await this.clearAllPersisted();
    return this.setState({ status: 'idle' });
  }

  async beginMagicLink(email: string): Promise<AuthFlowSnapshot> {
    this.assertCanBegin();
    await this.cleanupPromise;
    const normalizedEmail = normalizeEmail(email);
    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      await this.clearAllPersisted();
      const result = await this.auth.beginMagicLink({
        email: normalizedEmail,
        deviceId: device.id,
        state,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      const pending: PendingMagicLinkFlow = {
        flowId: result.flowId,
        state,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.clearPending();
      this.pendingMagicLink = pending;
      await this.persist(PENDING_MAGIC_CREDENTIAL, pending);

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
    await this.cleanupPromise;
    const pending = this.pendingMagicLink ?? await this.restoreMagicLink();
    if (!pending || pending.flowId !== input.flowId) {
      throw new Error('Fluxo de Magic Link inválido.');
    }
    if (await this.expired(pending.expiresAt, PENDING_MAGIC_CREDENTIAL)) {
      throw new AuthAdapterError('expired', 'Fluxo de autenticação expirado.');
    }

    if (input.state !== pending.state) {
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
      await this.removePersisted(PENDING_MAGIC_CREDENTIAL);
      return this.fail(error);
    }
  }

  async beginOAuth(provider: OAuthProvider): Promise<{
    snapshot: AuthFlowSnapshot;
    authorizationUrl: string;
  }> {
    this.assertCanBegin();
    await this.cleanupPromise;
    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      await this.clearAllPersisted();
      const result = await this.auth.beginOAuth({
        provider,
        deviceId: device.id,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      const pending: PendingOAuthFlow = {
        flowId: result.flowId,
        provider,
        state,
        nonce,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.clearPending();
      this.pendingOAuth = pending;
      await this.persist(PENDING_OAUTH_CREDENTIAL, pending);

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
    await this.cleanupPromise;
    const pending = this.pendingOAuth ?? await this.restoreOAuth();
    if (!pending || pending.flowId !== input.flowId) throw new Error('Fluxo OAuth inválido.');
    if (await this.expired(pending.expiresAt, PENDING_OAUTH_CREDENTIAL)) {
      throw new AuthAdapterError('expired', 'Fluxo de autenticação expirado.');
    }

    if (input.state !== pending.state) {
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
      await this.removePersisted(PENDING_OAUTH_CREDENTIAL);
      return this.fail(error);
    }
  }

  async failOAuthCallback(input: {
    flowId: string;
    error: string;
    errorDescription?: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    await this.cleanupPromise;
    const pending = this.pendingOAuth ?? await this.restoreOAuth();
    if (!pending || pending.flowId !== input.flowId) {
      throw new Error('Fluxo OAuth inválido.');
    }
    if (input.state !== pending.state) {
      return this.setState({
        status: 'error',
        method: 'oauth',
        provider: pending.provider,
        lastError: 'Estado OAuth inválido.',
      });
    }

    this.clearPending();
    await this.clearAllPersisted();
    const cancelled = input.error === 'access_denied' || input.error === 'cancelled';
    const safeDescription = input.errorDescription?.trim().slice(0, 512);
    return this.setState({
      status: 'error',
      method: 'oauth',
      provider: pending.provider,
      lastError: cancelled
        ? 'Autenticação cancelada.'
        : safeDescription || 'Não foi possível concluir a autenticação OAuth.',
    });
  }

  async beginPasskey(): Promise<{
    snapshot: AuthFlowSnapshot;
    authorizationUrl: string;
  }> {
    this.assertCanBegin();
    await this.cleanupPromise;
    const device = await this.requirePersistentDevice();
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = pkceChallenge(codeVerifier);

    try {
      await this.clearAllPersisted();
      const result = await this.auth.beginPasskey({
        deviceId: device.id,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      const pending: PendingPasskeyFlow = {
        flowId: result.flowId,
        state,
        nonce,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.clearPending();
      this.pendingPasskey = pending;
      await this.persist(PENDING_PASSKEY_CREDENTIAL, pending);

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
    flowId?: string;
    code: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    await this.cleanupPromise;
    const pending = this.pendingPasskey ?? await this.restorePasskey();
    if (!pending || (input.flowId !== undefined && pending.flowId !== input.flowId)) {
      throw new Error('Fluxo Passkey inválido.');
    }
    if (await this.expired(pending.expiresAt, PENDING_PASSKEY_CREDENTIAL)) {
      throw new AuthAdapterError('expired', 'Fluxo de autenticação expirado.');
    }

    if (input.state !== pending.state) {
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
      await this.removePersisted(PENDING_PASSKEY_CREDENTIAL);
      return this.fail(error);
    }
  }

  async failPasskeyCallback(input: {
    error: string;
    errorDescription?: string;
    state: string;
  }): Promise<AuthFlowSnapshot> {
    await this.cleanupPromise;
    const pending = this.pendingPasskey ?? await this.restorePasskey();
    if (!pending) throw new Error('Fluxo Passkey inválido.');
    if (input.state !== pending.state) {
      return this.setState({
        status: 'error',
        method: 'passkey',
        lastError: 'Estado Passkey inválido.',
      });
    }

    this.clearPending();
    await this.clearAllPersisted();
    const cancelled = input.error === 'access_denied' || input.error === 'cancelled';
    const safeDescription = input.errorDescription?.trim().slice(0, 512);
    return this.setState({
      status: 'error',
      method: 'passkey',
      lastError: cancelled
        ? 'Autenticação cancelada.'
        : safeDescription || 'Não foi possível concluir a autenticação com passkey.',
    });
  }

  async beginHosted(): Promise<{
    snapshot: AuthFlowSnapshot;
    authorizationUrl: string;
  }> {
    this.assertCanBegin();
    await this.cleanupPromise;
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
      await this.clearAllPersisted();
      const result = await begin.call(this.auth, {
        deviceId: device.id,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });

      const pending: PendingHostedFlow = {
        flowId: result.flowId,
        state,
        nonce,
        codeVerifier,
        expiresAt: result.expiresAt,
      };
      this.clearPending();
      this.pendingHosted = pending;
      await this.persist(PENDING_HOSTED_CREDENTIAL, pending);

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
    await this.cleanupPromise;
    const pending = this.pendingHosted ?? await this.restoreHosted();
    if (!pending) throw new Error('Fluxo hospedado inválido ou expirado.');
    if (await this.expired(pending.expiresAt, PENDING_HOSTED_CREDENTIAL)) {
      throw new AuthAdapterError('expired', 'Fluxo de autenticação expirado.');
    }

    if (input.state !== pending.state) {
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
      return await this.finishGrant(grant);
    } catch (error) {
      await this.removePersisted(PENDING_HOSTED_CREDENTIAL);
      return this.fail(error);
    }
  }

  async failHostedCallback(input: {
    error: string;
    errorDescription?: string;
    state?: string;
  }): Promise<AuthFlowSnapshot> {
    await this.cleanupPromise;
    const pending = this.pendingHosted ?? await this.restoreHosted();
    if (pending && input.state !== pending.state) {
      return this.setState({
        status: 'error',
        method: 'hosted',
        lastError: 'Estado de autenticação inválido.',
      });
    }

    this.clearPending();
    await this.clearAllPersisted();
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

  private async restoreOAuth(): Promise<PendingOAuthFlow | undefined> {
    const value = await this.readValidPersisted(PENDING_OAUTH_CREDENTIAL);
    if (!value) return undefined;
    if (
      value.provider !== 'github'
      && value.provider !== 'google'
      && value.provider !== 'microsoft'
    ) {
      await this.removePersisted(PENDING_OAUTH_CREDENTIAL);
      return undefined;
    }
    if (typeof value.nonce !== 'string' || value.nonce.length < 16 || value.nonce.length > 512) {
      await this.removePersisted(PENDING_OAUTH_CREDENTIAL);
      return undefined;
    }

    const restored: PendingOAuthFlow = {
      flowId: value.flowId as string,
      provider: value.provider,
      state: value.state as string,
      nonce: value.nonce,
      codeVerifier: value.codeVerifier as string,
      expiresAt: value.expiresAt as number,
    };
    this.pendingOAuth = restored;
    return restored;
  }

  private async restoreMagicLink(): Promise<PendingMagicLinkFlow | undefined> {
    const value = await this.readValidPersisted(PENDING_MAGIC_CREDENTIAL);
    if (!value) return undefined;
    const restored: PendingMagicLinkFlow = {
      flowId: value.flowId as string,
      state: value.state as string,
      codeVerifier: value.codeVerifier as string,
      expiresAt: value.expiresAt as number,
    };
    this.pendingMagicLink = restored;
    return restored;
  }

  private async restorePasskey(): Promise<PendingPasskeyFlow | undefined> {
    const value = await this.readValidPersisted(PENDING_PASSKEY_CREDENTIAL);
    if (!value) return undefined;
    if (typeof value.nonce !== 'string' || value.nonce.length < 16 || value.nonce.length > 512) {
      await this.removePersisted(PENDING_PASSKEY_CREDENTIAL);
      return undefined;
    }
    const restored: PendingPasskeyFlow = {
      flowId: value.flowId as string,
      state: value.state as string,
      nonce: value.nonce,
      codeVerifier: value.codeVerifier as string,
      expiresAt: value.expiresAt as number,
    };
    this.pendingPasskey = restored;
    return restored;
  }

  private async restoreHosted(): Promise<PendingHostedFlow | undefined> {
    const value = await this.readValidPersisted(PENDING_HOSTED_CREDENTIAL);
    if (!value) return undefined;
    if (typeof value.nonce !== 'string' || value.nonce.length < 16 || value.nonce.length > 512) {
      await this.removePersisted(PENDING_HOSTED_CREDENTIAL);
      return undefined;
    }
    const restored: PendingHostedFlow = {
      flowId: value.flowId as string,
      state: value.state as string,
      nonce: value.nonce,
      codeVerifier: value.codeVerifier as string,
      expiresAt: value.expiresAt as number,
    };
    this.pendingHosted = restored;
    return restored;
  }

  private async persist(key: string, value: object): Promise<void> {
    if (!this.pendingCredentials) return;
    await this.pendingCredentials.set(key, JSON.stringify(value));
  }

  private async readPersisted(key: string): Promise<Record<string, unknown> | undefined> {
    if (!this.pendingCredentials) return undefined;
    const raw = await this.pendingCredentials.get(key);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        await this.removePersisted(key);
        return undefined;
      }
      return value as Record<string, unknown>;
    } catch {
      await this.removePersisted(key);
      return undefined;
    }
  }

  private async readValidPersisted(key: string): Promise<Record<string, unknown> | undefined> {
    const value = await this.readPersisted(key);
    if (!value) return undefined;
    if (validBasePending(value, this.now())) return value;
    await this.removePersisted(key);
    return undefined;
  }

  private async removePersisted(key: string): Promise<void> {
    if (!this.pendingCredentials) return;
    await this.pendingCredentials.remove(key);
  }

  private schedulePersistedCleanup(): void {
    const cleanup = this.cleanupPromise.then(
      () => this.clearAllPersisted(),
      () => this.clearAllPersisted(),
    );
    this.cleanupPromise = cleanup.catch(() => undefined);
  }

  private async clearAllPersisted(): Promise<void> {
    if (!this.pendingCredentials) return;
    await Promise.all([
      this.pendingCredentials.remove(PENDING_OAUTH_CREDENTIAL),
      this.pendingCredentials.remove(PENDING_MAGIC_CREDENTIAL),
      this.pendingCredentials.remove(PENDING_PASSKEY_CREDENTIAL),
      this.pendingCredentials.remove(PENDING_HOSTED_CREDENTIAL),
    ]);
  }

  private async expired(expiresAt: number, key: string): Promise<boolean> {
    if (Number.isFinite(expiresAt) && expiresAt > this.now()) return false;
    this.clearPending();
    await this.removePersisted(key);
    this.setState({ status: 'error', lastError: 'Fluxo de autenticação expirado.' });
    return true;
  }

  private async finishGrant(grant: AuthGrant): Promise<AuthFlowSnapshot> {
    await this.sessions.establish(grant);
    this.clearPending();
    await this.clearAllPersisted();
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
