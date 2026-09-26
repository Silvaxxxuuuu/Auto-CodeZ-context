import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginLocalBridgeRuntime } from '../src/plugins/plugin-local-bridge';

const runtime = new PluginLocalBridgeRuntime();

test('local plugin bridge rejects HTTP methods outside its contract before opening a socket', async () => {
  await assert.rejects(
    () => runtime.request({ url: 'http://127.0.0.1:4567/', method: 'CONNECT' } as never),
    /método da bridge local inválido/i,
  );
});

test('local plugin bridge rejects malformed timeout and body values before opening a socket', async () => {
  await assert.rejects(
    () => runtime.request({ url: 'http://127.0.0.1:4567/', timeoutMs: Number.NaN } as never),
    /timeout da bridge local/i,
  );
  await assert.rejects(
    () => runtime.request({ url: 'http://127.0.0.1:4567/', body: { unsafe: true } } as never),
    /body da bridge local precisa ser texto/i,
  );
});

test('local plugin bridge rejects malformed headers before opening a socket', async () => {
  await assert.rejects(
    () => runtime.request({ url: 'http://127.0.0.1:4567/', headers: ['not', 'an', 'object'] } as never),
    /headers da bridge local inválidos/i,
  );
});
