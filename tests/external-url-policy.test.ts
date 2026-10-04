import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateExternalHostname, requirePublicExternalUrl } from '../src/core/external-url-policy';

test('external URL policy accepts ordinary public HTTP(S) destinations', () => {
  assert.equal(requirePublicExternalUrl('https://docs.example.com/path#section'), 'https://docs.example.com/path');
  assert.equal(requirePublicExternalUrl('http://example.com/'), 'http://example.com/');
});

test('external URL policy blocks dangerous schemes and embedded credentials', () => {
  assert.throws(() => requirePublicExternalUrl('file:///C:/Users/User/.env'), /HTTP\(S\)/);
  assert.throws(() => requirePublicExternalUrl('javascript:alert(1)'), /HTTP\(S\)/);
  assert.throws(() => requirePublicExternalUrl('https://user:pass@example.com/docs'), /credenciais/);
});

test('external URL policy blocks local, private and metadata-style hosts', () => {
  for (const url of [
    'http://localhost:3000/',
    'http://127.0.0.1:11434/',
    'http://10.0.0.4/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.20.2/',
    'https://192.168.1.10/',
    'http://metadata.google.internal/',
    'http://router.local/',
  ]) {
    assert.throws(() => requirePublicExternalUrl(url), /locais ou de rede privada/);
  }
});

test('external URL policy blocks private, mapped, link-local and multicast IPv6 literals', () => {
  assert.equal(isPrivateExternalHostname('::1'), true);
  assert.equal(isPrivateExternalHostname('fc00::1'), true);
  assert.equal(isPrivateExternalHostname('fd12:3456::1'), true);
  assert.equal(isPrivateExternalHostname('fe80::1'), true);
  assert.equal(isPrivateExternalHostname('::ffff:7f00:1'), true);
  assert.equal(isPrivateExternalHostname('ff02::1'), true);
  assert.throws(() => requirePublicExternalUrl('http://[::1]/'), /rede privada/);
  assert.throws(() => requirePublicExternalUrl('http://[fd12:3456::1]/'), /rede privada/);
  assert.throws(() => requirePublicExternalUrl('http://[fe80::1]/'), /rede privada/);
  assert.throws(() => requirePublicExternalUrl('http://[::ffff:127.0.0.1]/'), /rede privada/);
  assert.throws(() => requirePublicExternalUrl('http://[ff02::1]/'), /rede privada/);
});
