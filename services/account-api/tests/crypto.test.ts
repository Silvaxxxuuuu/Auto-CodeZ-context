import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  randomToken,
  signAccessToken,
  tokenHash,
  verifyAccessToken,
  verifyPkceS256,
} from '../src/crypto.js';

test('PKCE S256 accepts the matching verifier only', () => {
  const verifier = 'a'.repeat(64);
  const challenge = crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');

  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256(verifier + 'x', challenge), false);
});

test('desktop access token enforces issuer audience expiry and signature', () => {
  const token = signAccessToken({
    secret: 'test-secret-with-sufficient-entropy-for-unit-test',
    issuer: 'https://accounts.example.com',
    audience: 'auto-codez-desktop',
    userId: 'user-1',
    sessionId: 'session-1',
    deviceId: 'device-1',
    issuedAtSeconds: 100,
    expiresAtSeconds: 200,
  });

  assert.deepEqual(
    verifyAccessToken(token, {
      secret: 'test-secret-with-sufficient-entropy-for-unit-test',
      issuer: 'https://accounts.example.com',
      audience: 'auto-codez-desktop',
      nowSeconds: 150,
    }),
    {
      userId: 'user-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      expiresAtSeconds: 200,
    },
  );

  assert.throws(() => verifyAccessToken(token, {
    secret: 'different-secret',
    issuer: 'https://accounts.example.com',
    audience: 'auto-codez-desktop',
    nowSeconds: 150,
  }), /invalid_token/);

  assert.throws(() => verifyAccessToken(token, {
    secret: 'test-secret-with-sufficient-entropy-for-unit-test',
    issuer: 'https://accounts.example.com',
    audience: 'wrong-audience',
    nowSeconds: 150,
  }), /invalid_token/);

  assert.throws(() => verifyAccessToken(token, {
    secret: 'test-secret-with-sufficient-entropy-for-unit-test',
    issuer: 'https://accounts.example.com',
    audience: 'auto-codez-desktop',
    nowSeconds: 200,
  }), /expired_token/);
});

test('opaque tokens are random and only hashes need persistence', () => {
  const first = randomToken();
  const second = randomToken();

  assert.notEqual(first, second);
  assert.equal(first.length >= 64, true);
  assert.match(tokenHash(first), /^[a-f0-9]{64}$/);
  assert.notEqual(tokenHash(first), first);
});
