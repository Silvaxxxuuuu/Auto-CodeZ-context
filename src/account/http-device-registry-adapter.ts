import {
  DeviceRegistryAdapterError,
  type BeginDeviceRegistrationInput,
  type CompleteDeviceRegistrationInput,
  type DeviceRegistryAdapter,
  type RemoteDeviceRecord,
} from './device-registry-adapter';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface HttpDeviceRegistryAdapterOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string, max = 16_384): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${label} inválido.`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} inválido.`);
  return value;
}

function asPlatform(value: unknown): NodeJS.Platform {
  const platform = asString(value, 'Plataforma', 64);
  return platform as NodeJS.Platform;
}

function parseDevice(value: unknown): RemoteDeviceRecord {
  const source = asObject(value, 'Dispositivo');
  return {
    id: asString(source.id, 'ID do dispositivo', 256),
    name: asString(source.name, 'Nome do dispositivo', 80),
    platform: asPlatform(source.platform),
    arch: asString(source.arch, 'Arquitetura', 64),
    appVersion: asString(source.appVersion, 'Versão do app', 128),
    createdAt: asNumber(source.createdAt, 'Data de criação'),
    lastSeenAt: asNumber(source.lastSeenAt, 'Última atividade'),
    ...(source.revokedAt === undefined || source.revokedAt === null
      ? {}
      : { revokedAt: asNumber(source.revokedAt, 'Data de revogação') }),
  };
}

export class HttpDeviceRegistryAdapter implements DeviceRegistryAdapter {
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: HttpDeviceRegistryAdapterOptions = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') throw new Error('O Device Registry precisa usar HTTPS.');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('URL do Device Registry inválida.');
    this.origin = parsed.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async beginRegistration(input: BeginDeviceRegistrationInput): Promise<{ registrationId: string; challenge: string; expiresAt: number }> {
    const payload = asObject(await this.request('/v1/devices/register/begin', input.accessToken, input.device), 'Challenge');
    return {
      registrationId: asString(payload.registrationId, 'ID do registro', 256),
      challenge: asString(payload.challenge, 'Challenge', 16_384),
      expiresAt: asNumber(payload.expiresAt, 'Expiração do challenge'),
    };
  }

  async completeRegistration(input: CompleteDeviceRegistrationInput): Promise<RemoteDeviceRecord> {
    return parseDevice(await this.request('/v1/devices/register/complete', input.accessToken, {
      registrationId: input.registrationId,
      deviceId: input.deviceId,
      signature: input.signature,
    }));
  }

  async list(accessToken: string): Promise<RemoteDeviceRecord[]> {
    const payload = await this.request('/v1/devices/list', accessToken, {});
    if (!Array.isArray(payload)) throw new Error('Lista de dispositivos inválida.');
    return payload.map(parseDevice);
  }

  async rename(accessToken: string, deviceId: string, name: string): Promise<RemoteDeviceRecord> {
    return parseDevice(await this.request('/v1/devices/rename', accessToken, { deviceId, name }));
  }

  async revoke(accessToken: string, deviceId: string): Promise<void> {
    await this.request('/v1/devices/revoke', accessToken, { deviceId });
  }

  private async request(pathname: string, accessToken: string, body: unknown): Promise<unknown> {
    const token = accessToken.trim();
    if (!token || token.length > 32_768) throw new Error('Access token inválido.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(pathname, this.origin), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new DeviceRegistryAdapterError('unauthorized', 'Sessão não autorizada pelo Device Registry.');
        }
        throw new DeviceRegistryAdapterError('server', `Device Registry respondeu HTTP ${response.status}.`);
      }
      if (response.status === 204) return null;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) throw new Error('Resposta não JSON do Device Registry.');
      return await response.json();
    } catch (error) {
      if (error instanceof DeviceRegistryAdapterError) throw error;
      if (controller.signal.aborted) {
        throw new DeviceRegistryAdapterError('offline', 'Tempo limite ao conectar ao Device Registry.');
      }
      throw new DeviceRegistryAdapterError(
        'offline',
        error instanceof Error
          ? `Não foi possível conectar ao Device Registry: ${error.message}`
          : 'Não foi possível conectar ao Device Registry.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
