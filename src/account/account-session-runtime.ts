import type { LocalStorage } from '../core/storage';
import type {
  AccountProfile,
  AccountRuntimeSnapshot,
  AccountSession,
  DeviceRecord,
} from './types';
import type { AuthGrant, SessionAuthAdapter } from './auth-adapter';
import { AuthAdapterError } from './auth-adapter';
import type { ProtectedCredentialStore } from './protected-credential-store';
import { DeviceIdentityStore, suggestDeviceName } from './device-identity';

interface StoredAccountState {
  account: AccountProfile;
  session: AccountSession;
}

const STATE_FILE = 'account-session.json';
const REFRESH_TOKEN_CREDENTIAL = 'account.session.refresh-token';

function cloneProfile(profile: AccountProfile): AccountProfile {
  return {
    ...profile,
    identities: profile.identities.map((identity) => ({ ...identity })),
  };
}

function cloneSession(session: AccountSession): AccountSession {
  return { ...session };
}

function cloneDevice(device: DeviceRecord): DeviceRecord {
  return { ...device };
}

export class AccountSessionRuntime {
  private state: AccountRuntimeSnapshot | null = null;
  private accessToken: string | null = null;
  private refreshInFlight?: Promise<AccountRuntimeSnapshot>;
  private readonly listeners = new Set<(snapshot: AccountRuntimeSnapshot) => void>();

  constructor(
    private readonly storage: LocalStorage,
    private readonly credentials: ProtectedCredentialStore,
    private readonly deviceIdentity: DeviceIdentityStore,
    private readonly auth: SessionAuthAdapter,
  ) {}

  async hydrate(): Promise<AccountRuntimeSnapshot> {
    const device = await this.deviceIdentity.getOrCreate();
    const stored = await this.storage.read<StoredAccountState | null>(STATE_FILE, null);
    const refreshToken = await this.credentials.get(REFRESH_TOKEN_CREDENTIAL);

    if (!stored || !refreshToken) {
      await this.clearPersistedSession();
      this.accessToken = null;
      return this.setState({ state: 'signed_out', device });
    }

    this.setState({
      state: 'restoring',
      account: cloneProfile(stored.account),
      session: cloneSession(stored.session),
      device,
    });

    try {
      const grant = await this.auth.refresh({ refreshToken, deviceId: device.id });
      return await this.establish(grant, device);
    } catch (error) {
      if (error instanceof AuthAdapterError && error.code === 'offline') {
        this.accessToken = null;
        return this.setState({
          state: 'offline',
          account: cloneProfile(stored.account),
          session: cloneSession(stored.session),
          device,
          lastError: error.message,
        });
      }

      if (error instanceof AuthAdapterError && (error.code === 'revoked' || error.code === 'invalid_grant')) {
        await this.clearPersistedSession();
        this.accessToken = null;
        return this.setState({
          state: 'revoked',
          device,
          lastError: error.message,
        });
      }

      this.accessToken = null;
      return this.setState({
        state: 'error',
        account: cloneProfile(stored.account),
        session: cloneSession(stored.session),
        device,
        lastError: error instanceof Error ? error.message : 'Falha ao restaurar a sessão.',
      });
    }
  }

  async refreshSession(): Promise<AccountRuntimeSnapshot> {
    if (this.refreshInFlight) return await this.refreshInFlight;

    const operation = this.refreshSessionOnce();
    this.refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined;
    }
  }

  private async refreshSessionOnce(): Promise<AccountRuntimeSnapshot> {
    const current = this.state ?? await this.hydrate();
    const device = await this.deviceIdentity.getOrCreate();
    const refreshToken = await this.credentials.get(REFRESH_TOKEN_CREDENTIAL);

    if (!current.account || !current.session || !refreshToken) {
      await this.clearPersistedSession();
      this.accessToken = null;
      return this.setState({ state: 'signed_out', device });
    }

    try {
      const grant = await this.auth.refresh({ refreshToken, deviceId: device.id });
      return await this.establish(grant, device);
    } catch (error) {
      if (error instanceof AuthAdapterError && error.code === 'offline') {
        this.accessToken = null;
        return this.setState({
          state: 'offline',
          account: cloneProfile(current.account),
          session: cloneSession(current.session),
          device,
          lastError: error.message,
        });
      }

      if (error instanceof AuthAdapterError && (error.code === 'revoked' || error.code === 'invalid_grant')) {
        await this.clearPersistedSession();
        this.accessToken = null;
        return this.setState({
          state: 'revoked',
          device,
          lastError: error.message,
        });
      }

      this.accessToken = null;
      return this.setState({
        state: 'error',
        account: cloneProfile(current.account),
        session: cloneSession(current.session),
        device,
        lastError: error instanceof Error ? error.message : 'Falha ao renovar a sessão.',
      });
    }
  }

  async establish(grant: AuthGrant, deviceOverride?: DeviceRecord): Promise<AccountRuntimeSnapshot> {
    if (!grant.accessToken.trim() || !grant.refreshToken.trim()) throw new Error('Credenciais de sessão inválidas.');
    let device = deviceOverride ?? await this.deviceIdentity.getOrCreate();

    if (grant.session.deviceId !== device.id) {
      throw new Error('A sessão pertence a outro dispositivo.');
    }
    if (grant.session.accountId !== grant.account.id) {
      throw new Error('A sessão pertence a outra conta.');
    }

    if (device.name === 'Este dispositivo') {
      device = await this.deviceIdentity.rename(suggestDeviceName(grant.account.displayName));
    }

    try {
      await this.credentials.set(REFRESH_TOKEN_CREDENTIAL, grant.refreshToken);
      await this.storage.write<StoredAccountState>(STATE_FILE, {
        account: cloneProfile(grant.account),
        session: cloneSession(grant.session),
      });
    } catch (error) {
      await Promise.allSettled([
        this.credentials.remove(REFRESH_TOKEN_CREDENTIAL),
        this.storage.remove(STATE_FILE),
      ]);
      this.accessToken = null;
      this.setState({ state: 'signed_out', device });
      throw error;
    }

    this.accessToken = grant.accessToken;
    return this.setState({
      state: 'authenticated',
      account: cloneProfile(grant.account),
      session: cloneSession(grant.session),
      device,
    });
  }

  snapshot(): AccountRuntimeSnapshot {
    if (!this.state) throw new Error('AccountSessionRuntime ainda não foi inicializado.');
    return {
      ...this.state,
      account: this.state.account ? cloneProfile(this.state.account) : undefined,
      session: this.state.session ? cloneSession(this.state.session) : undefined,
      device: cloneDevice(this.state.device),
    };
  }

  subscribe(listener: (snapshot: AccountRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  async renameDevice(name: string): Promise<AccountRuntimeSnapshot> {
    const current = this.state ?? await this.hydrate();
    const device = await this.deviceIdentity.rename(name);
    return this.setState({
      ...current,
      device,
    });
  }

  async logout(): Promise<AccountRuntimeSnapshot> {
    if (this.refreshInFlight) {
      try {
        await this.refreshInFlight;
      } catch {
      }
    }
    const current = this.state ?? await this.hydrate();
    const refreshToken = await this.credentials.get(REFRESH_TOKEN_CREDENTIAL);

    if (current.session) {
      try {
        await this.auth.revoke({
          sessionId: current.session.id,
          refreshToken: refreshToken ?? undefined,
          deviceId: current.device.id,
        });
      } catch {
      }
    }

    await this.clearPersistedSession();
    this.accessToken = null;
    return this.setState({ state: 'signed_out', device: current.device });
  }

  private async clearPersistedSession(): Promise<void> {
    await Promise.all([
      this.storage.remove(STATE_FILE),
      this.credentials.remove(REFRESH_TOKEN_CREDENTIAL),
    ]);
  }

  private setState(snapshot: AccountRuntimeSnapshot): AccountRuntimeSnapshot {
    this.state = {
      ...snapshot,
      account: snapshot.account ? cloneProfile(snapshot.account) : undefined,
      session: snapshot.session ? cloneSession(snapshot.session) : undefined,
      device: cloneDevice(snapshot.device),
    };
    const current = this.snapshot();
    for (const listener of this.listeners) listener(current);
    return current;
  }
}
