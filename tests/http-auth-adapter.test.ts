import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpAuthAdapter } from '../src/account/http-auth-adapter';
import { AuthAdapterError, type BeginOAuthInput } from '../src/account/auth-adapter';

function grantPayload(deviceId = 'device-1') {
  return {
    account: {
      id: 'acct-1',
      primaryEmail: 'user@example.com',
      displayName: 'Gabriel',
      status: 'active',
      identities: [] as unknown[],
      createdAt: 1,
      updatedAt: 2,
    },
    session: {
      id: 'session-1',
      accountId: 'acct-1',
      deviceId,
      identityProvider: 'github',
      createdAt: 1,
      lastActivityAt: 2,
      accessExpiresAt: 3_000,
    },
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('HttpAuthAdapter requires HTTPS and rejects URL credentials/query fragments', () => {
  assert.throws(() => new HttpAuthAdapter('http://accounts.example.com'), /HTTPS/);
  assert.throws(() => new HttpAuthAdapter('https://user:pass@accounts.example.com'), /inválida/);
  assert.throws(() => new HttpAuthAdapter('https://accounts.example.com?token=x'), /inválida/);
  assert.throws(() => new HttpAuthAdapter('https://accounts.example.com#fragment'), /inválida/);
});

test('HttpAuthAdapter sends refresh token only in POST JSON body', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const adapter = new HttpAuthAdapter('https://accounts.example.com', {
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(grantPayload());
    },
  });

  const result = await adapter.refresh({
    refreshToken: 'refresh-super-secret',
    deviceId: 'device-1',
  });

  assert.equal(result.refreshToken, 'refresh-secret');
  assert.equal(capturedUrl, 'https://accounts.example.com/v1/auth/session/refresh');
  assert.equal(capturedUrl.includes('refresh-super-secret'), false);
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.credentials, 'omit');
  assert.equal(capturedInit?.redirect, 'error');
  assert.match(String(capturedInit?.body), /refresh-super-secret/);
});

test('HttpAuthAdapter validates OAuth authorization URL and request shape', async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new HttpAuthAdapter('https://accounts.example.com', {
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        flowId: 'flow-1',
        expiresAt: 5_000,
      });
    },
  });

  const input: BeginOAuthInput = {
    provider: 'github',
    deviceId: 'device-1',
    state: 'private-state',
    nonce: 'private-nonce',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
  };

  const result = await adapter.beginOAuth(input);
  assert.equal(result.flowId, 'flow-1');
  assert.deepEqual(body, input);

  const unsafe = new HttpAuthAdapter('https://accounts.example.com', {
    fetch: async () => jsonResponse({
      authorizationUrl: 'http://github.com/login/oauth/authorize',
      flowId: 'flow-1',
      expiresAt: 5_000,
    }),
  });

  await assert.rejects(
    unsafe.beginOAuth(input),
    /URL OAuth insegura/,
  );
});

test('HttpAuthAdapter rejects malformed grants before they reach session runtime', async () => {
  const adapter = new HttpAuthAdapter('https://accounts.example.com', {
    fetch: async () => jsonResponse({
      account: { id: 'acct-1' },
      session: {},
      accessToken: 'token',
      refreshToken: 'refresh',
    }),
  });

  await assert.rejects(
    adapter.refresh({ refreshToken: 'refresh', deviceId: 'device-1' }),
    (error: unknown) => error instanceof AuthAdapterError && error.code === 'server',
  );
});

test('HttpAuthAdapter maps remote invalid_grant without exposing response internals', async () => {
  const adapter = new HttpAuthAdapter('https://accounts.example.com', {
    fetch: async () => jsonResponse({
      code: 'invalid_grant',
      message: 'Sessão expirada.',
    }, 401),
  });

  await assert.rejects(
    adapter.refresh({ refreshToken: 'refresh', deviceId: 'device-1' }),
    (error: unknown) => (
      error instanceof AuthAdapterError
      && error.code === 'invalid_grant'
      && error.message === 'Sessão expirada.'
    ),
  );
});

test('HttpAuthAdapter rejects non-JSON successful responses', async () => {
  const adapter = new HttpAuthAdapter('https://accounts.example.com', {
    fetch: async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
  });

  await assert.rejects(
    adapter.beginMagicLink({ email: 'user@example.com', deviceId: 'device-1' }),
    /Resposta não JSON/,
  );
});
