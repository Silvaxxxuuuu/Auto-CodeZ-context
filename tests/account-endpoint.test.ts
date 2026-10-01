import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountApiBaseUrl } from '../src/account/account-endpoint';

test('account endpoint runtime override wins over bundled default', () => {
  assert.equal(
    resolveAccountApiBaseUrl(' https://runtime.example.com ', 'https://release.example.com'),
    'https://runtime.example.com',
  );
});

test('account endpoint falls back to bundled release URL', () => {
  assert.equal(
    resolveAccountApiBaseUrl(undefined, ' https://release.example.com '),
    'https://release.example.com',
  );
});

test('account endpoint remains disabled when no endpoint is configured', () => {
  assert.equal(resolveAccountApiBaseUrl('  ', ''), undefined);
});
