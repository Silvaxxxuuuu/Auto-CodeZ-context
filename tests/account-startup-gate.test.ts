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
