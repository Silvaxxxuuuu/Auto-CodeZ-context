import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('renderer bootstrap waits for Account Core readiness before releasing startup splash', async () => {
  const entry = await fs.readFile('src/renderer-entry.ts', 'utf8');
  const criticalAwait = entry.indexOf('await Promise.all(criticalLoads);');
  const accountAwait = entry.indexOf('await waitForAccountReady();');
  const bootstrapReady = entry.indexOf("dataset.autoCodezBootstrapReady = 'true'");

  assert.ok(criticalAwait >= 0);
  assert.ok(accountAwait > criticalAwait);
  assert.ok(bootstrapReady > accountAwait);
});

test('account onboarding always resolves its initial readiness marker', async () => {
  const source = await fs.readFile('src/account-ui.ts', 'utf8');
  assert.match(source, /finally\s*\{\s*markAccountReady\(\);\s*\}/);
  assert.match(source, /if \(!bridge\)\s*\{\s*markAccountReady\(\);/);
});


test('device onboarding only completes after Device Registry rename succeeds', async () => {
  const source = await fs.readFile('src/account-ui.ts', 'utf8');
  const start = source.indexOf('async function finishDevice');
  const end = source.indexOf("document.addEventListener('submit'", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  const remoteRename = body.indexOf('await bridge.renameAccountDeviceRegistryCurrent(normalized);');
  const localRename = body.indexOf('accountState = await bridge.renameAccountDevice(normalized);');
  const completion = body.indexOf('localStorage.setItem(DEVICE_ONBOARDING_KEY');

  assert.ok(remoteRename >= 0);
  assert.ok(localRename > remoteRename);
  assert.ok(completion > localRename);
  assert.doesNotMatch(body, /renameAccountDeviceRegistryCurrent\(normalized\)\.catch/);
  assert.match(source, /const deviceError = flowState\.status === 'error' \? flowState\.lastError : undefined;/);
  assert.match(source, /account-inline-error\" role=\"alert/);
});
