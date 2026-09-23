import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DescopeAuthAdapter } from '../src/account/descope-auth-adapter';

const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = signingKey.publicKey.export({ format: 'jwk' });
if (!publicJwk.n || !publicJwk.e) throw new Error('Falha ao gerar chave RSA de teste.');

function signJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    kid: 'test-key',
    typ: 'JWT',
  }), 'utf8').toString('base64url');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signed = `${header}.${body}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signed, 'utf8'),
    signingKey.privateKey,
  ).toString('base64url');
  return `${signed}.${signature}`;
}

function idToken(nonce: string, subject = 'user-123'): string {
  return signJwt({
    iss: 'https://api.descope.com/P2abcDEF_123',
    sub: subject,
    aud: 'P2abcDEF_123',
    azp: 'P2abcDEF_123',
    exp: 1_700_003_600,
    iat: 1_700_000_000,
    nonce,
  });
}

function sessionJwt(subject = 'user-123', issuer = 'P2abcDEF_123'): string {
  return signJwt({
    iss: issuer,
    sub: subject,
    exp: 1_700_003_600,
    iat: 1_700_000_000,
  });
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

function directUser() {
  return {
    userId: 'user-123',
    email: 'user@example.com',
    name: 'User Example',
    picture: 'https://example.com/avatar.png',
    loginIds: ['user@example.com'],
    createdTime: 1_700_000_000,
    TOTP: false,
    SAML: false,
    SCIM: false,
    password: false,
    status: 'enabled',
    test: false,
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
  assert.equal(grant.refreshToken, 'descope-oidc:descope:refresh-token');

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
  const badIdToken = signJwt({
    iss: 'https://api.descope.com/P2abcDEF_123',
    sub: 'user-123',
    aud: 'P2abcDEF_123',
    azp: 'different-client',
    exp: 1_700_003_600,
    iat: 1_700_000_000,
    nonce: 'outer-nonce',
  });

  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input) => {
      if (String(input).endsWith('/oauth2/v1/token')) {
        return jsonResponse({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          id_token: badIdToken,
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

test('native Google/GitHub/Microsoft OAuth starts at Descope API and returns directly to Auto CodeZ', async () => {
  for (const provider of ['github', 'google', 'microsoft'] as const) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        const url = new URL(String(input));
        if (url.pathname === '/v1/auth/oauth/authorize') {
          assert.equal(url.searchParams.get('provider'), provider);
          const redirect = new URL(url.searchParams.get('redirectURL') || '');
          assert.equal(redirect.protocol, 'autocodez:');
          assert.equal(redirect.hostname, 'auth');
          assert.equal(redirect.pathname, '/oauth');
          assert.equal(redirect.searchParams.get('state'), 'state-1234567890123456');
          assert.ok(redirect.searchParams.get('flowId'));
          assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer P2abcDEF_123');
          return jsonResponse({ url: `https://identity.example.test/${provider}/authorize` });
        }
        if (url.pathname === '/v1/auth/oauth/exchange') {
          assert.deepEqual(JSON.parse(String(init?.body)), { code: 'provider-code' });
          return jsonResponse({
            sessionJwt: sessionJwt(),
            refreshJwt: 'refresh-direct',
            sessionExpiration: 1_700_003_600,
            user: directUser(),
          });
        }
        if (url.pathname === '/v2/keys/P2abcDEF_123') return jsonResponse(jwks());
        throw new Error(`unexpected request: ${url}`);
      },
    });

    const started = await adapter.beginOAuth({
      provider,
      deviceId: 'device-1',
      state: 'state-1234567890123456',
      nonce: 'nonce-1234567890123456',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    });
    assert.equal(new URL(started.authorizationUrl).protocol, 'https:');

    const grant = await adapter.completeOAuth({
      flowId: started.flowId,
      provider,
      deviceId: 'device-1',
      code: 'provider-code',
      state: 'state-1234567890123456',
      nonce: 'nonce-1234567890123456',
      codeVerifier: 'verifier',
    });

    assert.equal(grant.account.id, 'user-123');
    assert.equal(grant.account.primaryEmail, 'user@example.com');
    assert.equal(grant.session.identityProvider, provider);
    assert.equal(grant.accessToken, sessionJwt());
    assert.equal(grant.refreshToken, `descope-direct:${provider}:refresh-direct`);
    assert.equal(calls.length, 3);
  }
});

test('native OAuth rejects a signed session for a different Descope project', async () => {
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/auth/oauth/exchange') {
        return jsonResponse({
          sessionJwt: sessionJwt('user-123', 'P2differentProject'),
          refreshJwt: 'refresh-direct',
          user: directUser(),
        });
      }
      if (url.pathname === '/v2/keys/P2abcDEF_123') return jsonResponse(jwks());
      throw new Error('unexpected request');
    },
  });

  await assert.rejects(
    adapter.completeOAuth({
      flowId: 'flow',
      provider: 'github',
      deviceId: 'device-1',
      code: 'code',
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
    }),
    /Issuer do Session JWT inválido/,
  );
});

test('Magic Link uses Descope sign-up-or-in and verifies the one-time token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const url = new URL(String(input));
      if (url.pathname === '/v1/auth/magiclink/signup-in/email') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.loginId, 'user@example.com');
        const redirect = new URL(String(body.URI));
        assert.equal(redirect.protocol, 'autocodez:');
        assert.equal(redirect.pathname, '/magic-link');
        assert.equal(redirect.searchParams.get('state'), 'magic-state-1234567890123456');
        return jsonResponse({});
      }
      if (url.pathname === '/v1/auth/magiclink/verify') {
        assert.deepEqual(JSON.parse(String(init?.body)), { token: 'magic-one-time-token' });
        return jsonResponse({
          sessionJwt: sessionJwt(),
          refreshJwt: 'magic-refresh',
          user: directUser(),
        });
      }
      if (url.pathname === '/v2/keys/P2abcDEF_123') return jsonResponse(jwks());
      throw new Error('unexpected request');
    },
  });

  const started = await adapter.beginMagicLink({
    email: 'user@example.com',
    deviceId: 'device-1',
    state: 'magic-state-1234567890123456',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
  });
  const grant = await adapter.completeMagicLink({
    flowId: started.flowId,
    token: 'magic-one-time-token',
    deviceId: 'device-1',
    state: 'magic-state-1234567890123456',
    codeVerifier: 'verifier',
  });

  assert.equal(grant.session.identityProvider, 'magic_link');
  assert.equal(grant.refreshToken, 'descope-direct:magic_link:magic-refresh');
  assert.equal(calls.length, 3);
});

test('Passkey keeps the secure OIDC PKCE ceremony on a dedicated callback', async () => {
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async () => { throw new Error('network should not be used during begin'); },
  });

  const started = await adapter.beginPasskey({
    deviceId: 'device-1',
    state: 'passkey-state',
    nonce: 'passkey-nonce',
    codeChallenge: 'passkey-challenge',
    codeChallengeMethod: 'S256',
  });
  const url = new URL(started.authorizationUrl);
  assert.equal(url.pathname, '/oauth2/v1/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'autocodez://auth/passkey');
  assert.equal(url.searchParams.get('state'), 'passkey-state');
  assert.equal(url.searchParams.get('nonce'), 'passkey-nonce');
  assert.equal(url.searchParams.get('code_challenge'), 'passkey-challenge');
  assert.equal(url.searchParams.get('autocodez_method'), 'passkey');
});

test('direct refresh preserves provider, rotates refresh token, and uses Descope session auth header', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    now: () => 1_700_000_000_000,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const url = new URL(String(input));
      if (url.pathname === '/v1/auth/refresh') {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          'Bearer P2abcDEF_123:refresh-old',
        );
        return jsonResponse({
          sessionJwt: sessionJwt(),
          refreshJwt: 'refresh-new',
        });
      }
      if (url.pathname === '/v2/keys/P2abcDEF_123') return jsonResponse(jwks());
      if (url.pathname === '/v1/auth/me') {
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          'Bearer P2abcDEF_123:refresh-new',
        );
        return jsonResponse(directUser());
      }
      throw new Error('unexpected request');
    },
  });

  const grant = await adapter.refresh({
    refreshToken: 'descope-direct:google:refresh-old',
    deviceId: 'device-1',
  });

  assert.equal(grant.refreshToken, 'descope-direct:google:refresh-new');
  assert.equal(grant.session.identityProvider, 'google');
  assert.equal(grant.accessToken, sessionJwt());
  assert.equal(calls.length, 3);
});

test('direct logout revokes only the current Descope refresh session', async () => {
  let logoutCalls = 0;
  const adapter = new DescopeAuthAdapter('P2abcDEF_123', {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== '/v1/auth/logout') throw new Error('unexpected request');
      logoutCalls += 1;
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        'Bearer P2abcDEF_123:refresh-secret',
      );
      return new Response(null, { status: 204 });
    },
  });

  await adapter.revoke({
    refreshToken: 'descope-direct:github:refresh-secret',
    deviceId: 'device-1',
  });
  assert.equal(logoutCalls, 1);
});

test('legacy OIDC refresh keeps a non-rotated refresh token and upgrades storage tagging', async () => {
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

  assert.equal(grant.refreshToken, 'descope-oidc:descope:refresh-old');
  assert.equal(grant.accessToken, 'access-new');
  assert.equal(grant.session.accessExpiresAt, 1_700_001_800_000);
});
