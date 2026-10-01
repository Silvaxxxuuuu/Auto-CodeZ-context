import test from 'node:test';
import assert from 'node:assert/strict';
import { findAccountAuthCallback, parseAccountAuthCallback } from '../src/account/account-auth-callback';

test('parseAccountAuthCallback accepts OAuth callbacks only on the Auto CodeZ scheme', () => {
  assert.deepEqual(
    parseAccountAuthCallback('autocodez://auth/oauth?flowId=flow-1&code=one-time-code&state=state-1'),
    {
      type: 'oauth',
      flowId: 'flow-1',
      code: 'one-time-code',
      state: 'state-1',
    },
  );
  assert.throws(
    () => parseAccountAuthCallback('https://example.com/oauth?flowId=flow-1&code=x&state=y'),
    /não reconhecido/,
  );
});

test('parseAccountAuthCallback accepts Magic Link callbacks and rejects missing secrets', () => {
  assert.deepEqual(
    parseAccountAuthCallback('autocodez://auth/magic-link?flowId=magic-1&t=one-time-token&state=state-1'),
    {
      type: 'magic_link',
      flowId: 'magic-1',
      token: 'one-time-token',
      state: 'state-1',
    },
  );
  assert.throws(
    () => parseAccountAuthCallback('autocodez://auth/magic-link?flowId=magic-1&state=state-1'),
    /token/,
  );
});

test('findAccountAuthCallback extracts callback URL from desktop argv', () => {
  assert.equal(
    findAccountAuthCallback([
      'Auto CodeZ.exe',
      '--flag',
      'autocodez://auth/oauth?flowId=f&code=c&state=s',
    ]),
    'autocodez://auth/oauth?flowId=f&code=c&state=s',
  );
  assert.equal(findAccountAuthCallback(['Auto CodeZ.exe']), undefined);
});


test('parseAccountAuthCallback accepts browser passkey callbacks', () => {
  assert.deepEqual(
    parseAccountAuthCallback('autocodez://auth/passkey?code=one-time-code&state=state-1'),
    {
      type: 'passkey',
      code: 'one-time-code',
      state: 'state-1',
    },
  );
});

test('parseAccountAuthCallback accepts hosted identity callbacks', () => {
  assert.deepEqual(
    parseAccountAuthCallback('autocodez://auth/hosted?code=authorization-code&state=state-1'),
    {
      type: 'hosted',
      code: 'authorization-code',
      state: 'state-1',
    },
  );
});


test('parseAccountAuthCallback accepts hosted provider cancellation safely', () => {
  assert.deepEqual(
    parseAccountAuthCallback('autocodez://auth/hosted?error=access_denied&error_description=User%20cancelled&state=state-1'),
    {
      type: 'hosted_error',
      error: 'access_denied',
      errorDescription: 'User cancelled',
      state: 'state-1',
    },
  );
  assert.deepEqual(
    parseAccountAuthCallback('autocodez://auth/hosted?error=server_error'),
    {
      type: 'hosted_error',
      error: 'server_error',
    },
  );
});


test('parseAccountAuthCallback accepts native OAuth cancellation without exposing a code', () => {
  assert.deepEqual(
    parseAccountAuthCallback(
      'autocodez://auth/oauth?flowId=flow-1&error=access_denied&error_description=User%20cancelled&state=state-1',
    ),
    {
      type: 'oauth_error',
      flowId: 'flow-1',
      error: 'access_denied',
      errorDescription: 'User cancelled',
      state: 'state-1',
    },
  );
});

test('parseAccountAuthCallback accepts passkey cancellation on its dedicated callback', () => {
  assert.deepEqual(
    parseAccountAuthCallback(
      'autocodez://auth/passkey?error=access_denied&error_description=User%20cancelled&state=state-1',
    ),
    {
      type: 'passkey_error',
      error: 'access_denied',
      errorDescription: 'User cancelled',
      state: 'state-1',
    },
  );
});
