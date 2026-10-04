import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { resolvePublicWebUrl, type PublicWebDestination, type WebHostResolver } from './web-network-policy';

export type WebHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type WebHttpTransportOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
};

export type WebHttpTransport = (destination: PublicWebDestination, options: WebHttpTransportOptions) => Promise<WebHttpResponse>;

export type PublicTextRequestOptions = {
  resolver?: WebHostResolver;
  transport?: WebHttpTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export type PublicTextResponse = {
  url: string;
  status: number;
  contentType: string;
  text: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
];

function abortError(): Error {
  const error = new Error('Operação web cancelada.');
  error.name = 'AbortError';
  return error;
}

function normalizedHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(', ');
  }
  return result;
}

function serverName(url: URL): string | undefined {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  return net.isIP(hostname) ? undefined : hostname;
}

export const defaultWebHttpTransport: WebHttpTransport = async (destination, options) => {
  if (options.signal?.aborted) throw abortError();
  const address = destination.addresses[0];
  if (!address) throw new Error('Destino web sem endereço público validado.');
  const url = destination.url;
  const isHttps = url.protocol === 'https:';
  const requestOptions: https.RequestOptions = {
    protocol: url.protocol,
    hostname: address.address,
    family: address.family,
    port: url.port || (isHttps ? 443 : 80),
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: {
      Host: url.host,
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1',
      'User-Agent': 'Auto-CodeZ/2.0 WebRetrieval',
      'Accept-Encoding': 'identity',
    },
    ...(isHttps && serverName(url) ? { servername: serverName(url) } : {}),
  };

  return await new Promise<WebHttpResponse>((resolve, reject) => {
    const request = (isHttps ? https.request : http.request)(requestOptions, (response) => {
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        response.destroy();
        reject(new Error('A resposta web excede o limite permitido.'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | Uint8Array | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > options.maxBytes) {
          response.destroy(new Error('A resposta web excede o limite permitido.'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizedHeaders(response.headers),
          body: Buffer.concat(chunks),
        });
      });
    });

    const onAbort = () => request.destroy(abortError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.once('close', () => options.signal?.removeEventListener('abort', onAbort));
    request.once('error', reject);
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('A requisição web excedeu o tempo limite.')));
    request.end();
  });
};

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAllowedContentType(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((allowed) => allowed.endsWith('/') ? normalized.startsWith(allowed) : normalized === allowed);
}

export async function requestPublicText(input: string | URL, options: PublicTextRequestOptions = {}): Promise<PublicTextResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout web inválido.');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Limite de resposta web inválido.');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new Error('Limite de redirects web inválido.');

  const transport = options.transport ?? defaultWebHttpTransport;
  let current = input instanceof URL ? new URL(input.toString()) : new URL(input);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (options.signal?.aborted) throw abortError();
    const destination = await resolvePublicWebUrl(current, options.resolver);
    const response = await transport(destination, { signal: options.signal, timeoutMs, maxBytes });
    if (isRedirect(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error('Redirect web sem destino.');
      if (redirect === maxRedirects) throw new Error('A requisição web excedeu o limite de redirects.');
      current = new URL(location, destination.url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`A fonte web respondeu com HTTP ${response.status}.`);
    const contentType = response.headers['content-type'] || 'text/plain';
    if (!isAllowedContentType(contentType)) throw new Error(`Tipo de conteúdo web não permitido: ${contentType}.`);
    return {
      url: destination.url.toString(),
      status: response.status,
      contentType,
      text: new TextDecoder().decode(response.body),
    };
  }
  throw new Error('A requisição web não pôde ser concluída.');
}
