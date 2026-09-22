import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DescopeAuthAdapter } from '../src/account/descope-auth-adapter';

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = signingKey.publicKey.export({ format: 'jwk' });
if (!publicJwk.n || !publicJwk.e) throw new Error('Falha ao gerar chave RSA de teste.');

function idToken(nonce: string, subject = 'user-123'): string {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    kid: 'test-key',
    typ: 'JWT',
  }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://api.descope.com/P2abcDEF_123',
    sub: subject,
    aud: 'P2abcDEF_123',
    azp: 'P2abcDEF_123',
    exp: 1_700_003_600,
    iat: 1_700_000_000,
    nonce,
  }), 'utf8').toString('base64url');
  const signed = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signed, 'utf8'), signingKey.privateKey).toString('base64url');
  return `${signed}.${signature}`;
}

function jwks() {
  return {
    keys: [{
      kty: 'RSA',
      kid: 'test-key',
      alg: 'RS256',
      use: 'sig',
      n: publicJwk.n,
      e: publicJwk.e,
    }],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Descope hosted auth uses public-client PKCE and custom desktop callback', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/oauth2/v1/token')) {
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          id_token: idToken('outer-nonce'),
        });
      }
      if (String(input).endsWith('/P2abcDEF_123/.well-known/jwks.json')) {
        return jsonResponse(jwks());
      }
      if (String(input).endsWith('/oauth2/v1/userinfo')) {
        return jsonResponse({
          sub: 'user-123',
          email: 'user@example.com',
          name: 'User Example',
          preferred_username: 'userexample',
          picture: 'https://example.com/avatar.png',
        });
      }
      throw new Error('unexpected request');
    },
  });

  const beginHosted = adapter.beginHosted;
  assert.ok(beginHosted);
  const begin = await beginHosted.call(adapter, {
    deviceId: 'device-1',
    state: 'outer-state',
    nonce: 'outer-nonce',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
  });

  const authorize = new URL(begin.authorizationUrl);
  assert.equal(authorize.origin, 'https://api.descope.com');
  assert.equal(authorize.pathname, '/oauth2/v1/authorize');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('client_id'), 'P2abcDEF_123');
  assert.equal(authorize.searchParams.get('code_challenge'), 'challenge');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('state'), 'outer-state');
  assert.equal(authorize.searchParams.get('nonce'), 'outer-nonce');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'autocodez://auth/hosted');
  assert.equal(authorize.searchParams.get('scope'), 'openid profile email offline_access');

  const completeHosted = adapter.completeHosted;
  assert.ok(completeHosted);
  const grant = await completeHosted.call(adapter, {
    flowId: begin.flowId,
    deviceId: 'device-1',
    code: 'authorization-code',
    state: 'outer-state',
    nonce: 'outer-nonce',
    codeVerifier: 'verifier',
  });

  assert.equal(grant.account.id, 'user-123');
  assert.equal(grant.account.primaryEmail, 'user@example.com');
  assert.equal(grant.account.displayName, 'User Example');
  assert.equal(grant.session.deviceId, 'device-1');
  assert.equal(grant.session.identityProvider, 'descope');
  assert.equal(grant.accessToken, 'access-token');
  assert.equal(grant.refreshToken, 'refresh-token');

  const tokenRequest = calls[0];
  assert.match(tokenRequest.url, /\/oauth2\/v1\/token$/);
  const body = tokenRequest.init?.body;
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'P2abcDEF_123');
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.get('code_verifier'), 'verifier');
  assert.equal(body.get('redirect_uri'), 'autocodez://auth/hosted');
});

test('Descope hosted auth rejects an ID token with the wrong nonce before UserInfo', async () => {
  let userInfoRequested = false;
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input) => {
      if (String(input).endsWith('/oauth2/v1/token')) {
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          id_token: idToken('wrong-nonce'),
        });
      }
      if (String(input).endsWith('/P2abcDEF_123/.well-known/jwks.json')) {
        return jsonResponse(jwks());
      }
      if (String(input).endsWith('/oauth2/v1/userinfo')) {
        userInfoRequested = true;
        return jsonResponse({
          sub: 'user-123',
          email: 'user@example.com',
        });
      }
      throw new Error('unexpected request');
    },
  });

  const beginHosted = adapter.beginHosted;
  const completeHosted = adapter.completeHosted;
  assert.ok(beginHosted);
  assert.ok(completeHosted);

  const begin = await beginHosted.call(adapter, {
    deviceId: 'device-1',
    state: 'outer-state',
    nonce: 'outer-nonce',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
  });

  await assert.rejects(
    completeHosted.call(adapter, {
      flowId: begin.flowId,
      deviceId: 'device-1',
      code: 'authorization-code',
      state: 'outer-state',
      nonce: 'outer-nonce',
      codeVerifier: 'verifier',
    }),
    /Nonce do ID token inválido/,
  );
  assert.equal(userInfoRequested, false);
});

test('Descope hosted auth rejects an ID token for a different authorized party', async () => {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    kid: 'test-key',
    typ: 'JWT',
  }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://api.descope.com/P2abcDEF_123',
    sub: 'user-123',
    aud: 'P2abcDEF_123',
    azp: 'different-client',
    exp: 1_700_003_600,
    iat: 1_700_000_000,
    nonce: 'outer-nonce',
  }), 'utf8').toString('base64url');
  const signed = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signed, 'utf8'), signingKey.privateKey).toString('base64url');

  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input) => {
      if (String(input).endsWith('/oauth2/v1/token')) {
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          id_token: `${signed}.${signature}`,
        });
      }
      if (String(input).endsWith('/P2abcDEF_123/.well-known/jwks.json')) {
        return jsonResponse(jwks());
      }
      throw new Error('unexpected request');
    },
  });

  const beginHosted = adapter.beginHosted;
  const completeHosted = adapter.completeHosted;
  assert.ok(beginHosted);
  assert.ok(completeHosted);
  const begin = await beginHosted.call(adapter, {
    deviceId: 'device-1',
    state: 'outer-state',
    nonce: 'outer-nonce',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
  });

  await assert.rejects(
    completeHosted.call(adapter, {
      flowId: begin.flowId,
      deviceId: 'device-1',
      code: 'authorization-code',
      state: 'outer-state',
      nonce: 'outer-nonce',
      codeVerifier: 'verifier',
    }),
    /Authorized party do ID token inválido/,
  );
});

test('Descope refresh keeps a non-rotated refresh token', async () => {
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input, init) => {
      if (String(input).endsWith('/oauth2/v1/token')) {
        const body = init?.body;
        assert.ok(body instanceof URLSearchParams);
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'refresh-old');
        return jsonResponse({
          access_token: 'access-new',
          expires_in: 1800,
        });
      }
      if (String(input).endsWith('/oauth2/v1/userinfo')) {
        return jsonResponse({
          sub: 'user-123',
          email: 'user@example.com',
          name: 'User Example',
        });
      }
      throw new Error('unexpected request');
    },
  });

  const grant = await adapter.refresh({
    refreshToken: 'refresh-old',
    deviceId: 'device-1',
  });

  assert.equal(grant.refreshToken, 'refresh-old');
  assert.equal(grant.accessToken, 'access-new');
  assert.equal(grant.session.accessExpiresAt, 1_700_001_800_000);
});
