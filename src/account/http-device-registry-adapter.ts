import crypto from 'node:crypto';
import {
  DeviceRegistryAdapterError,
  type BeginDeviceRegistrationInput,
  type CompleteDeviceRegistrationInput,
  type DeviceRegistryAdapter,
  type DeviceRequestProofSigner,
  type RemoteDeviceRecord,
} from './device-registry-adapter';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface HttpDeviceRegistryAdapterOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  proofSigner?: DeviceRequestProofSigner;
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

async function responseErrorCode(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return undefined;
  try {
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const code = (payload as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

export class HttpDeviceRegistryAdapter implements DeviceRegistryAdapter {
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly proofSigner?: DeviceRequestProofSigner;

  constructor(baseUrl: string, options: HttpDeviceRegistryAdapterOptions = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:') throw new Error('O Device Registry precisa usar HTTPS.');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('URL do Device Registry inválida.');
    this.origin = parsed.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.proofSigner = options.proofSigner;
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
    const payload = await this.request('/v1/devices/list', accessToken, {}, true);
    if (!Array.isArray(payload)) throw new Error('Lista de dispositivos inválida.');
    return payload.map(parseDevice);
  }

  async rename(accessToken: string, deviceId: string, name: string): Promise<RemoteDeviceRecord> {
    return parseDevice(await this.request('/v1/devices/rename', accessToken, { deviceId, name }, true));
  }

  async revoke(accessToken: string, deviceId: string): Promise<void> {
    await this.request('/v1/devices/revoke', accessToken, { deviceId }, true);
  }

  private async request(pathname: string, accessToken: string, body: unknown, requireDeviceProof = false): Promise<unknown> {
    const token = accessToken.trim();
    if (!token || token.length > 32_768) throw new Error('Access token inválido.');
    const bodyText = JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    if (requireDeviceProof && this.proofSigner) {
      const timestamp = Date.now();
      const nonce = crypto.randomBytes(18).toString('base64url');
      const bodyHash = crypto.createHash('sha256').update(bodyText, 'utf8').digest('base64url');
      const challenge = `autocodez-device-v1\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
      const proof = await this.proofSigner(challenge);
      headers['x-autocodez-device-id'] = proof.deviceId;
      headers['x-autocodez-device-timestamp'] = String(timestamp);
      headers['x-autocodez-device-nonce'] = nonce;
      headers['x-autocodez-device-signature'] = proof.signature;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(pathname, this.origin), {
        method: 'POST',
        headers,
        body: bodyText,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new DeviceRegistryAdapterError('unauthorized', 'Sessão não autorizada pelo Device Registry.');
        }
        if (response.status === 403) {
          const code = await responseErrorCode(response);
          if (code === 'device_revoked') {
            throw new DeviceRegistryAdapterError('revoked', 'Este dispositivo foi revogado no Device Registry.');
          }
          throw new DeviceRegistryAdapterError('forbidden', 'O Device Registry recusou a prova deste dispositivo.');
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
