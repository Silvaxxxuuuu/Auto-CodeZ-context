import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DescopeSessionVerifier } from '../src/descope-session-verifier.js';

const projectId = 'P2abcDEF_123';
const nowMs = 1_800_000_000_000;

function createSigningKey(kid: string) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      kty: 'RSA',
      kid,
      n: jwk.n!,
      e: jwk.e!,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

function token(
  key: ReturnType<typeof createSigningKey>,
  payloadOverrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
    kid: key.kid,
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://api.descope.com/' + projectId,
    sub: 'user-descope-1',
    aud: projectId,
    iat: Math.floor(nowMs / 1000) - 30,
    exp: Math.floor(nowMs / 1000) + 300,
    ...payloadOverrides,
  })).toString('base64url');
  const data = header + '.' + payload;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(data, 'utf8'), key.privateKey).toString('base64url');
  return data + '.' + signature;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('DescopeSessionVerifier validates RS256 session JWT with project audience', async () => {
  const key = createSigningKey('session-key');
  const requested: string[] = [];
  const verifier = new DescopeSessionVerifier(projectId, {
    now: () => nowMs,
    fetch: async (input) => {
      requested.push(String(input));
      return json({ keys: [key.publicJwk] });
    },
  });

  const context = await verifier.validate(token(key));

  assert.deepEqual(context, { userId: 'user-descope-1' });
  assert.equal(requested.some((url) => url.includes('/v2/keys/' + projectId)), true);
});

test('DescopeSessionVerifier accepts OIDC access-token signing keys when session JWKS uses another kid', async () => {
  const sessionKey = createSigningKey('session-key');
  const oidcKey = createSigningKey('oidc-key');
  const verifier = new DescopeSessionVerifier(projectId, {
    now: () => nowMs,
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/jwks.json')) return json({ keys: [oidcKey.publicJwk] });
      return json({ keys: [sessionKey.publicJwk] });
    },
  });

  assert.deepEqual(await verifier.validate(token(oidcKey)), { userId: 'user-descope-1' });
});

test('DescopeSessionVerifier rejects tokens for another audience', async () => {
  const key = createSigningKey('session-key');
  const verifier = new DescopeSessionVerifier(projectId, {
    now: () => nowMs,
    fetch: async () => json({ keys: [key.publicJwk] }),
  });

  await assert.rejects(
    verifier.validate(token(key, { aud: 'another-project' })),
    /invalid_token/,
  );
});

test('DescopeSessionVerifier rejects expired and incorrectly signed tokens', async () => {
  const trusted = createSigningKey('session-key');
  const attacker = createSigningKey('session-key');
  const verifier = new DescopeSessionVerifier(projectId, {
    now: () => nowMs,
    fetch: async () => json({ keys: [trusted.publicJwk] }),
  });

  await assert.rejects(
    verifier.validate(token(trusted, { exp: Math.floor(nowMs / 1000) - 30 })),
    /expired_token/,
  );
  await assert.rejects(
    verifier.validate(token(attacker)),
    /invalid_token/,
  );
});

test('DescopeSessionVerifier rejects issuer outside the configured project', async () => {
  const key = createSigningKey('session-key');
  const verifier = new DescopeSessionVerifier(projectId, {
    now: () => nowMs,
    fetch: async () => json({ keys: [key.publicJwk] }),
  });

  await assert.rejects(
    verifier.validate(token(key, { iss: 'https://api.descope.com/P2otherProject' })),
    /invalid_token/,
  );
});
