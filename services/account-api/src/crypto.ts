import crypto from 'node:crypto';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function tokenHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (!verifier || verifier.length > 512 || !expectedChallenge) return false;
  const actual = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
  const left = Buffer.from(actual);
  const right = Buffer.from(expectedChallenge);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signAccessToken(input: {
  secret: string;
  issuer: string;
  audience: string;
  userId: string;
  sessionId: string;
  deviceId: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
}): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: input.issuer,
    aud: input.audience,
    sub: input.userId,
    sid: input.sessionId,
    did: input.deviceId,
    iat: input.issuedAtSeconds,
    exp: input.expiresAtSeconds,
  }));
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', input.secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyAccessToken(token: string, input: {
  secret: string;
  issuer: string;
  audience: string;
  nowSeconds: number;
}): { userId: string; sessionId: string; deviceId: string; expiresAtSeconds: number } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [headerPart, payloadPart, signature] = parts;
  const data = `${headerPart}.${payloadPart}`;
  const expected = crypto.createHmac('sha256', input.secret).update(data).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error('invalid_token');

  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('invalid_token');
  if (payload.iss !== input.issuer || payload.aud !== input.audience) throw new Error('invalid_token');
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.did !== 'string') throw new Error('invalid_token');
  if (typeof payload.exp !== 'number' || payload.exp <= input.nowSeconds) throw new Error('expired_token');
  return {
    userId: payload.sub,
    sessionId: payload.sid,
    deviceId: payload.did,
    expiresAtSeconds: payload.exp,
  };
}
