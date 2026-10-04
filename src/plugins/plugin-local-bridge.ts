import http from 'node:http';
import https from 'node:https';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type PluginBridgeRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
};

export type PluginBridgeResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

function parseLoopbackUrl(raw: string): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('URL da bridge local inválida.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL da bridge local inválida.');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new Error('Bridge local aceita apenas HTTP(S).');
  if (url.username || url.password) throw new Error('Credenciais embutidas na URL da bridge não são permitidas.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Bridge de plugin só pode acessar loopback local.');
  }
  if (!url.port) throw new Error('Bridge local exige uma porta explícita.');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta da bridge local inválida.');
  return url;
}

function validateMethod(value: unknown): PluginBridgeRequest['method'] {
  if (value === undefined) return 'GET';
  if (typeof value !== 'string' || !ALLOWED_METHODS.has(value)) throw new Error('Método da bridge local inválido.');
  return value as PluginBridgeRequest['method'];
}

function validateTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new Error('Timeout da bridge local deve ser um inteiro entre 100 e 60000 ms.');
  }
  return value;
}

function validateBody(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('Body da bridge local precisa ser texto.');
  if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Payload da bridge local excede 2 MB.');
  return value;
}

function validateHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers))) throw new Error('Headers da bridge local inválidos.');
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(normalizedName)) throw new Error('Header da bridge local inválido.');
    if (normalizedName === 'host' || normalizedName === 'connection' || normalizedName === 'content-length') continue;
    if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('Valor de header da bridge local inválido.');
    output[normalizedName] = value;
  }
  return output;
}

export class PluginLocalBridgeRuntime {
  async request(input: PluginBridgeRequest, signal?: AbortSignal): Promise<PluginBridgeResponse> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Solicitação da bridge local inválida.');
    const url = parseLoopbackUrl(input.url);
    const method = validateMethod(input.method);
    const headers = validateHeaders(input.headers);
    const body = validateBody(input.body);
    const timeoutMs = validateTimeout(input.timeoutMs);
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<PluginBridgeResponse>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = transport.request({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: timeoutMs,
      }, (response) => {
        const location = response.headers.location;
        if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          finishReject(new Error('Redirects não são permitidos em bridges locais de plugins.'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Resposta da bridge local excede 2 MB.'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') responseHeaders[name] = value;
            else if (Array.isArray(value)) responseHeaders[name] = value.join(', ');
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      request.on('timeout', () => request.destroy(new Error('Bridge local excedeu o tempo limite.')));
      request.on('error', (error) => finishReject(error));
      const abort = () => request.destroy(new DOMException('Operação cancelada.', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      request.on('close', () => signal?.removeEventListener('abort', abort));
      if (body) request.write(body);
      request.end();
    });
  }
}

export function validatePluginLocalBridgeUrl(url: string): string {
  return parseLoopbackUrl(url).toString();
}
