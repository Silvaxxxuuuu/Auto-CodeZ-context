import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountAuthAdapter } from '../src/account/auth-adapter-factory';
import { UnavailableAuthAdapter } from '../src/account/auth-adapter';
import { HttpAuthAdapter } from '../src/account/http-auth-adapter';

test('account auth factory stays disabled when no backend is configured', () => {
  const result = createAccountAuthAdapter(undefined);
  assert.equal(result.configuration.configured, false);
  assert.deepEqual(result.configuration.methods, []);
  assert.equal(result.configuration.configurationError, undefined);
  assert.ok(result.adapter instanceof UnavailableAuthAdapter);
});

test('account auth factory enables all passwordless methods for a valid HTTPS backend', () => {
  const result = createAccountAuthAdapter('https://accounts.autocodez.example');
  assert.equal(result.configuration.configured, true);
  assert.deepEqual(result.configuration.methods, [
    'magic_link',
    'github',
    'google',
    'microsoft',
    'passkey',
  ]);
  assert.ok(result.adapter instanceof HttpAuthAdapter);
});

test('account auth factory fails closed without blocking local app on invalid configuration', () => {
  const result = createAccountAuthAdapter('http://accounts.autocodez.example');
  assert.equal(result.configuration.configured, false);
  assert.deepEqual(result.configuration.methods, []);
  assert.match(result.configuration.configurationError ?? '', /HTTPS/);
  assert.ok(result.adapter instanceof UnavailableAuthAdapter);
});
