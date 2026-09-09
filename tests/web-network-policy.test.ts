import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicWebUrl, isUnsafeWebAddress, type WebHostResolver } from '../src/web/web-network-policy';

const publicResolver: WebHostResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('web network policy accepts public HTTPS destinations', async () => {
  const url = await assertPublicWebUrl('https://example.com/docs?q=1', publicResolver);
  assert.equal(url.hostname, 'example.com');
  assert.equal(url.protocol, 'https:');
});

test('web network policy blocks loopback, private, link-local and reserved IPv4 destinations', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.4.8', '192.168.1.1', '169.254.169.254', '100.64.1.1', '192.0.2.1', '198.51.100.8', '203.0.113.9', '224.0.0.1']) {
    assert.equal(isUnsafeWebAddress(address), true, address);
    await assert.rejects(() => assertPublicWebUrl(`http://${address}/`), /rede local ou reservada/);
  }
});

test('web network policy blocks IPv6 loopback, unique-local and link-local destinations', async () => {
  for (const address of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
    assert.equal(isUnsafeWebAddress(address), true, address);
    await assert.rejects(() => assertPublicWebUrl(`http://[${address}]/`), /rede local ou reservada/);
  }
});

test('web network policy blocks local hostnames before DNS resolution', async () => {
  let calls = 0;
  const resolver: WebHostResolver = async () => {
    calls += 1;
    return [{ address: '93.184.216.34', family: 4 }];
  };
  for (const hostname of ['localhost', 'api.localhost', 'device.local', 'service.internal', 'metadata.google.internal']) {
    await assert.rejects(() => assertPublicWebUrl(`http://${hostname}/`, resolver), /rede local ou reservada/);
  }
  assert.equal(calls, 0);
});

test('web network policy rejects a public-looking hostname when any DNS answer is private', async () => {
  const resolver: WebHostResolver = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(() => assertPublicWebUrl('https://example.com/', resolver), /resolveu para uma rede local ou reservada/);
});

test('web network policy rejects unsupported protocols and embedded credentials', async () => {
  await assert.rejects(() => assertPublicWebUrl('file:///etc/passwd', publicResolver), /somente HTTP ou HTTPS/);
  await assert.rejects(() => assertPublicWebUrl('https://user:secret@example.com/', publicResolver), /credenciais embutidas/);
});
