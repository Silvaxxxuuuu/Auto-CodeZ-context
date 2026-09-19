import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountAuthAdapter, resolveAccountAuthConfiguration } from '../src/account/auth-adapter-factory';
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


test('account auth discovery disables blocking login when configured backend is unavailable', async () => {
  const result = createAccountAuthAdapter('https://accounts.autocodez.example');
  result.adapter.configuration = async () => {
    throw new Error('backend offline');
  };

  assert.deepEqual(
    await resolveAccountAuthConfiguration(result),
    {
      configured: false,
      methods: [],
      configurationError: 'backend offline',
    },
  );
});

test('visual auth discovery uses deterministic configured capabilities without network discovery', async () => {
  const result = createAccountAuthAdapter('https://accounts.autocodez.example');
  let discoveryCalls = 0;
  result.adapter.configuration = async () => {
    discoveryCalls += 1;
    throw new Error('visual backend should not be contacted');
  };

  const configuration = await resolveAccountAuthConfiguration(result, true);
  assert.equal(discoveryCalls, 0);
  assert.equal(configuration.configured, true);
  assert.deepEqual(configuration.methods, ['magic_link', 'github', 'google', 'microsoft', 'passkey']);
  assert.equal(configuration.configurationError, undefined);
});
