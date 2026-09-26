import type { AccountSessionRuntime } from './account-session-runtime';
import type { DeviceIdentityStore } from './device-identity';
import {
  DeviceRegistryAdapterError,
  type DeviceRegistryAdapter,
  type RemoteDeviceRecord,
} from './device-registry-adapter';

export type DeviceRegistryState =
  | 'unavailable'
  | 'idle'
  | 'registering'
  | 'ready'
  | 'offline'
  | 'error';

export interface DeviceRegistrySnapshot {
  state: DeviceRegistryState;
  devices: RemoteDeviceRecord[];
  currentDeviceId?: string;
  lastError?: string;
}

function cloneDevice(device: RemoteDeviceRecord): RemoteDeviceRecord {
  return { ...device };
}

function cloneSnapshot(snapshot: DeviceRegistrySnapshot): DeviceRegistrySnapshot {
  return {
    ...snapshot,
    devices: snapshot.devices.map(cloneDevice),
  };
}

function normalizeDeviceName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Nome do dispositivo inválido.');
  return normalized.slice(0, 80);
}

function registryFailureState(error: unknown): 'offline' | 'error' | 'unavailable' {
  if (!(error instanceof DeviceRegistryAdapterError)) return 'error';
  if (error.code === 'offline') return 'offline';
  if (error.code === 'not_configured' || error.code === 'revoked') return 'unavailable';
  return 'error';
}

export class DeviceRegistryRuntime {
  private state: DeviceRegistrySnapshot = { state: 'idle', devices: [] };
  private readonly listeners = new Set<(snapshot: DeviceRegistrySnapshot) => void>();
  private registrationInFlight?: Promise<DeviceRegistrySnapshot>;

  constructor(
    private readonly sessions: AccountSessionRuntime,
    private readonly devices: DeviceIdentityStore,
    private readonly adapter: DeviceRegistryAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): DeviceRegistrySnapshot {
    return cloneSnapshot(this.state);
  }

  subscribe(listener: (snapshot: DeviceRegistrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): DeviceRegistrySnapshot {
    this.registrationInFlight = undefined;
    return this.setState({ state: 'idle', devices: [] });
  }

  markOffline(): DeviceRegistrySnapshot {
    const currentDeviceId = this.state.currentDeviceId;
    return this.setState({
      state: 'offline',
      devices: this.state.devices,
      ...(currentDeviceId ? { currentDeviceId } : {}),
      lastError: 'Sem conexão para atualizar o Device Registry.',
    });
  }

  async ensureRegistered(): Promise<DeviceRegistrySnapshot> {
    if (this.registrationInFlight) return await this.registrationInFlight;
    const operation = this.registerCurrentDevice();
    this.registrationInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.registrationInFlight === operation) this.registrationInFlight = undefined;
    }
  }

  private async registerCurrentDevice(): Promise<DeviceRegistrySnapshot> {
    const session = this.sessions.snapshot();
    const accessToken = this.sessions.getAccessToken();
    const localDevice = await this.devices.getOrCreate();

    if (session.state === 'offline' || !accessToken) {
      return this.setState({
        state: session.state === 'offline' ? 'offline' : 'unavailable',
        devices: this.state.devices,
        currentDeviceId: localDevice.id,
        lastError: session.state === 'offline'
          ? 'Sem conexão para atualizar o Device Registry.'
          : 'Sessão autenticada indisponível para o Device Registry.',
      });
    }

    if (session.state !== 'authenticated') {
      return this.setState({
        state: 'unavailable',
        devices: [],
        currentDeviceId: localDevice.id,
      });
    }

    if (localDevice.credentialPersistence !== 'protected') {
      return this.setState({
        state: 'unavailable',
        devices: [],
        currentDeviceId: localDevice.id,
        lastError: 'Armazenamento seguro do sistema indisponível para registrar este dispositivo.',
      });
    }

    this.setState({
      state: 'registering',
      devices: this.state.devices,
      currentDeviceId: localDevice.id,
    });

    try {
      const begin = await this.adapter.beginRegistration({
        accessToken,
        device: {
          id: localDevice.id,
          name: localDevice.name,
          platform: localDevice.platform,
          arch: localDevice.arch,
          appVersion: localDevice.appVersion,
          publicKey: localDevice.publicKey,
        },
      });

      if (!begin.registrationId.trim() || !begin.challenge.trim()) {
        throw new Error('Challenge de registro inválido.');
      }
      if (!Number.isFinite(begin.expiresAt) || begin.expiresAt <= this.now()) {
        throw new Error('Challenge de registro expirado.');
      }

      const signature = await this.devices.signChallenge(begin.challenge);
      await this.adapter.completeRegistration({
        accessToken,
        registrationId: begin.registrationId,
        deviceId: localDevice.id,
        signature,
      });

      return await this.refresh();
    } catch (error) {
      if (error instanceof DeviceRegistryAdapterError) {
        if (error.code === 'unauthorized') void this.sessions.refreshSession();
        else if (error.code === 'revoked') await this.sessions.logout();
      }
      return this.setState({
        state: registryFailureState(error),
        devices: this.state.devices,
        currentDeviceId: localDevice.id,
        lastError: error instanceof Error ? error.message : 'Falha ao registrar o dispositivo.',
      });
    }
  }

  async refresh(): Promise<DeviceRegistrySnapshot> {
    const session = this.sessions.snapshot();
    const accessToken = this.sessions.getAccessToken();
    const localDevice = await this.devices.getOrCreate();

    if (session.state === 'offline' || !accessToken) {
      return this.setState({
        state: session.state === 'offline' ? 'offline' : 'unavailable',
        devices: this.state.devices,
        currentDeviceId: localDevice.id,
      });
    }

    try {
      const remote = await this.adapter.list(accessToken);
      const unique = new Map(remote.map((device) => [device.id, cloneDevice(device)]));
      return this.setState({
        state: 'ready',
        devices: [...unique.values()],
        currentDeviceId: localDevice.id,
      });
    } catch (error) {
      if (error instanceof DeviceRegistryAdapterError) {
        if (error.code === 'unauthorized') void this.sessions.refreshSession();
        else if (error.code === 'revoked') await this.sessions.logout();
      }
      return this.setState({
        state: registryFailureState(error),
        devices: this.state.devices,
        currentDeviceId: localDevice.id,
        lastError: error instanceof Error ? error.message : 'Falha ao consultar dispositivos.',
      });
    }
  }

  async renameCurrent(name: string): Promise<DeviceRegistrySnapshot> {
    const accessToken = this.sessions.getAccessToken();
    if (!accessToken) throw new Error('Sessão autenticada indisponível.');

    const normalizedName = normalizeDeviceName(name);
    const local = await this.devices.getOrCreate();
    const remoteCurrent = this.state.devices.find((device) => device.id === local.id && !device.revokedAt);
    if (this.state.state !== 'ready' || !remoteCurrent) {
      const registered = await this.ensureRegistered();
      const confirmed = registered.devices.find((device) => device.id === local.id && !device.revokedAt);
      if (registered.state !== 'ready' || !confirmed) {
        throw new Error(registered.lastError || 'Dispositivo ainda não foi registrado remotamente.');
      }
    }
    await this.adapter.rename(accessToken, local.id, normalizedName);
    await this.devices.rename(normalizedName);
    return await this.refresh();
  }

  async revoke(deviceId: string): Promise<DeviceRegistrySnapshot> {
    const accessToken = this.sessions.getAccessToken();
    if (!accessToken) throw new Error('Sessão autenticada indisponível.');
    const id = deviceId.trim();
    if (!id) throw new Error('Dispositivo inválido.');

    try {
      await this.adapter.revoke(accessToken, id);
      return await this.refresh();
    } catch (error) {
      if (error instanceof DeviceRegistryAdapterError) {
        if (error.code === 'unauthorized') void this.sessions.refreshSession();
        else if (error.code === 'revoked') await this.sessions.logout();
      }
      const currentDeviceId = this.state.currentDeviceId;
      return this.setState({
        state: registryFailureState(error),
        devices: this.state.devices,
        ...(currentDeviceId ? { currentDeviceId } : {}),
        lastError: error instanceof Error ? error.message : 'Falha ao revogar o dispositivo.',
      });
    }
  }

  private setState(snapshot: DeviceRegistrySnapshot): DeviceRegistrySnapshot {
    this.state = cloneSnapshot(snapshot);
    const current = this.snapshot();
    for (const listener of this.listeners) listener(current);
    return current;
  }
}
