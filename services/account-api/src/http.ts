import type { Request } from 'express';

export function requestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} invalid.`);
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string, max = 16_384): string {
  if (typeof value !== 'string') throw new Error(`${label} invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} invalid.`);
  return normalized;
}

export function optionalString(value: unknown, label: string, max = 16_384): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label, max);
}

export function requireProvider(value: unknown): 'github' | 'google' | 'microsoft' {
  const provider = requireString(value, 'provider', 32);
  if (provider !== 'github' && provider !== 'google' && provider !== 'microsoft') {
    throw new Error('provider invalid.');
  }
  return provider;
}

export function bearerToken(request: Request): string {
  const authorization = request.header('authorization')?.trim() ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new Error('missing_bearer_token');
  return requireString(match[1], 'access token', 32_768);
}

export function sendError(response: { status(code: number): { json(value: unknown): unknown } }, error: unknown): void {
  const message = error instanceof Error ? error.message : 'request_failed';
  const status = message === 'invalid_grant' || message === 'invalid_token' || message === 'expired_token'
    ? 401
    : message === 'not_found'
      ? 404
      : message === 'forbidden' || message === 'device_revoked'
        ? 403
        : message.endsWith('invalid.')
          ? 400
          : 500;
  const code = message === 'device_revoked'
    ? 'device_revoked'
    : message === 'forbidden'
      ? 'forbidden'
      : message === 'not_found'
        ? 'not_found'
        : status === 401
          ? 'invalid_grant'
          : 'server';
  response.status(status).json({
    code,
    message: status >= 500 ? 'Falha no serviço de autenticação.' : message,
  });
}
