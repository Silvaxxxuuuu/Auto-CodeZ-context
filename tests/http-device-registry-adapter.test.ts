import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpDeviceRegistryAdapter } from '../src/account/http-device-registry-adapter';
import { DeviceRegistryAdapterError } from '../src/account/device-registry-adapter';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('HttpDeviceRegistryAdapter keeps bearer token in Authorization header', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const adapter = new HttpDeviceRegistryAdapter('https://accounts.example.com', {
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return json({
        registrationId: 'registration-1',
        challenge: 'challenge',
        expiresAt: 5_000,
      });
    },
  });

  await adapter.beginRegistration({
    accessToken: 'access-secret',
    device: {
      id: 'device-1',
      name: 'Meu PC',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0',
      publicKey: 'public-key',
    },
  });

  assert.equal(capturedUrl, 'https://accounts.example.com/v1/devices/register/begin');
  assert.equal(capturedUrl.includes('access-secret'), false);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer access-secret');
  assert.equal(String(capturedInit?.body).includes('access-secret'), false);
});

test('HttpDeviceRegistryAdapter validates remote device list', async () => {
  const adapter = new HttpDeviceRegistryAdapter('https://accounts.example.com', {
    fetch: async () => json([{
      id: 'device-1',
      name: 'Meu PC',
      platform: 'win32',
      arch: 'x64',
      appVersion: '2.0.0',
      createdAt: 1,
      lastSeenAt: 2,
    }]),
  });

  const devices = await adapter.list('access-secret');
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.id, 'device-1');
});

test('HttpDeviceRegistryAdapter rejects insecure backend URLs', () => {
  assert.throws(() => new HttpDeviceRegistryAdapter('http://accounts.example.com'), /HTTPS/);
  assert.throws(() => new HttpDeviceRegistryAdapter('https://user:pass@accounts.example.com'), /inválida/);
});


test('HttpDeviceRegistryAdapter classifies network failures as offline', async () => {
  const adapter = new HttpDeviceRegistryAdapter('https://accounts.example.com', {
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    adapter.list('access-secret'),
    (error: unknown) => error instanceof DeviceRegistryAdapterError && error.code === 'offline',
  );
});

test('HttpDeviceRegistryAdapter classifies 401 as unauthorized', async () => {
  const adapter = new HttpDeviceRegistryAdapter('https://accounts.example.com', {
    fetch: async () => json({ code: 'invalid_grant' }, 401),
  });

  await assert.rejects(
    adapter.list('access-secret'),
    (error: unknown) => error instanceof DeviceRegistryAdapterError && error.code === 'unauthorized',
  );
});
