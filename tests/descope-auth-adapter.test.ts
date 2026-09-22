import test from 'node:test';
import assert from 'node:assert/strict';
import { DescopeAuthAdapter } from '../src/account/descope-auth-adapter';

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
          id_token: 'id-token',
        });
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
