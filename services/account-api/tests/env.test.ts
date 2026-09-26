import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvironment } from '../src/env.js';

const managedKeys = [
  'ACCOUNT_PUBLIC_URL',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'ACCOUNT_ACCESS_TOKEN_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING',
  'AZURE_EMAIL_SENDER',
  'PASSKEY_RP_ID',
  'PASSKEY_RP_NAME',
  'PORT',
] as const;

function withEnvironment(
  overrides: Record<string, string | undefined>,
  operation: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of managedKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  Object.assign(process.env, {
    ACCOUNT_PUBLIC_URL: 'https://accounts.example.test',
    DATABASE_URL: 'postgresql://example.invalid/autocodez',
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    ACCOUNT_ACCESS_TOKEN_SECRET: 'a'.repeat(32),
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    operation();
  } finally {
    for (const key of managedKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Account API rejects weak authentication secrets', () => {
  withEnvironment({ BETTER_AUTH_SECRET: 'too-short' }, () => {
    assert.throws(() => loadEnvironment(), /BETTER_AUTH_SECRET must contain at least 32 bytes/);
  });

  withEnvironment({ ACCOUNT_ACCESS_TOKEN_SECRET: 'too-short' }, () => {
    assert.throws(() => loadEnvironment(), /ACCOUNT_ACCESS_TOKEN_SECRET must contain at least 32 bytes/);
  });
});

test('Account API accepts independent 32-byte-or-longer secrets', () => {
  withEnvironment({}, () => {
    const environment = loadEnvironment();
    assert.equal(environment.betterAuthSecret.length, 32);
    assert.equal(environment.accessTokenSecret.length, 32);
    assert.equal(environment.publicUrl, 'https://accounts.example.test');
  });
});


test('Account API rejects non-origin public URLs', () => {
  withEnvironment({ ACCOUNT_PUBLIC_URL: 'https://accounts.example.test/account-api' }, () => {
    assert.throws(() => loadEnvironment(), /HTTPS origin/);
  });

  withEnvironment({ ACCOUNT_PUBLIC_URL: 'https://accounts.example.test?tenant=x' }, () => {
    assert.throws(() => loadEnvironment(), /HTTPS origin/);
  });
});
