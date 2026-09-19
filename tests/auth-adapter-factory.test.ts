import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountAuthAdapter } from '../src/account/auth-adapter-factory';
import { UnavailableAuthAdapter } from '../src/account/auth-adapter';
import { HttpAuthAdapter } from '../src/account/http-auth-adapter';
import { HttpDeviceRegistryAdapter } from '../src/account/http-device-registry-adapter';
import { UnavailableDeviceRegistryAdapter } from '../src/account/device-registry-adapter';

test('account auth factory stays disabled when no backend is configured', () => {
  const result = createAccountAuthAdapter(undefined);
  assert.equal(result.configuration.configured, false);
  assert.deepEqual(result.configuration.methods, []);
  assert.equal(result.configuration.configurationError, undefined);
  assert.ok(result.adapter instanceof UnavailableAuthAdapter);
  assert.ok(result.deviceRegistry instanceof UnavailableDeviceRegistryAdapter);
});

test('account auth factory enables all passwordless methods for a valid HTTPS backend', () => {
  const result = createAccountAuthAdapter('https://accounts.autocodez.example');
  assert.equal(result.configuration.configured, true);
  assert.equal(result.publicOrigin, 'https://accounts.autocodez.example');
  assert.deepEqual(result.configuration.methods, [
    'magic_link',
    'github',
    'google',
    'microsoft',
    'passkey',
  ]);
  assert.ok(result.adapter instanceof HttpAuthAdapter);
  assert.ok(result.deviceRegistry instanceof HttpDeviceRegistryAdapter);
});

test('account auth factory fails closed without blocking local app on invalid configuration', () => {
  const result = createAccountAuthAdapter('http://accounts.autocodez.example');
  assert.equal(result.configuration.configured, false);
  assert.equal(result.publicOrigin, undefined);
  assert.deepEqual(result.configuration.methods, []);
  assert.match(result.configuration.configurationError ?? '', /HTTPS/);
  assert.ok(result.adapter instanceof UnavailableAuthAdapter);
  assert.ok(result.deviceRegistry instanceof UnavailableDeviceRegistryAdapter);
});
