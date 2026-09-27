import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { McpConnectionRegistry } from '../src/mcp-gateway/connection-registry';

function secureStorage(): SecureStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8'),
    decrypt: (value) => value.toString('utf8'),
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-mcp-connections-'));
  const storage = new LocalStorage(root, secureStorage());
  await storage.init();
  let now = 1_000;
  const registry = new McpConnectionRegistry(storage, () => now++);
  await registry.init();
  return {
    root,
    storage,
    registry,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('MCP connection registry persists added clients in encrypted local storage', async () => {
  const f = await fixture();
  try {
    const added = await f.registry.add('codex');
    assert.equal(added.clientId, 'codex');
    assert.equal(added.setupState, 'added');
    assert.deepEqual(f.registry.list().map((item) => item.clientId), ['codex']);

    const raw = await fs.readFile(path.join(f.root, 'mcp-connections.json'), 'utf8');
    assert.equal(raw.includes('"codex"'), false);

    const restored = new McpConnectionRegistry(f.storage);
    await restored.init();
    assert.deepEqual(restored.list().map((item) => item.clientId), ['codex']);
  } finally {
    await f.cleanup();
  }
});

test('MCP connection registry keeps configuration metadata without storing control-plane secrets', async () => {
  const f = await fixture();
  try {
    const tunnelId = 'tunnel_' + 'a'.repeat(32);
    const configured = await f.registry.markConfigured('chatgpt', { tunnelId });
    assert.equal(configured.setupState, 'configured');
    assert.equal(configured.metadata?.tunnelId, tunnelId);
    assert.ok(configured.configuredAt);

    const connected = await f.registry.markConnected('chatgpt', { tunnelId });
    assert.ok(connected.lastConnectedAt);
    assert.equal(connected.metadata?.autoReconnect, true);
    assert.equal(JSON.stringify(connected).includes('apiKey'), false);
    assert.equal(JSON.stringify(connected).includes('bearer'), false);

    const disconnected = await f.registry.markDisconnected('chatgpt');
    assert.equal(disconnected.setupState, 'configured');
    assert.equal(disconnected.metadata?.tunnelId, tunnelId);
    assert.equal(disconnected.metadata?.autoReconnect, false);
    assert.ok(disconnected.lastConnectedAt);

    const restored = new McpConnectionRegistry(f.storage);
    await restored.init();
    assert.equal(restored.get('chatgpt')?.metadata?.autoReconnect, false);
  } finally {
    await f.cleanup();
  }
});

test('MCP connection registry can downgrade a configured client back to added state', async () => {
  const f = await fixture();
  try {
    const tunnelId = 'tunnel_' + 'b'.repeat(32);
    const connected = await f.registry.markConnected('chatgpt', { tunnelId });
    assert.equal(connected.setupState, 'configured');
    assert.ok(connected.configuredAt);
    assert.ok(connected.lastConnectedAt);
    assert.equal(connected.metadata?.tunnelId, tunnelId);

    const added = await f.registry.markAdded('chatgpt');
    assert.equal(added.setupState, 'added');
    assert.equal(added.addedAt, connected.addedAt);
    assert.equal(added.configuredAt, undefined);
    assert.equal(added.lastConnectedAt, undefined);
    assert.equal(added.metadata, undefined);

    const restored = new McpConnectionRegistry(f.storage);
    await restored.init();
    const persisted = restored.get('chatgpt');
    assert.equal(persisted?.setupState, 'added');
    assert.equal(persisted?.configuredAt, undefined);
    assert.equal(persisted?.lastConnectedAt, undefined);
    assert.equal(persisted?.metadata, undefined);
  } finally {
    await f.cleanup();
  }
});

test('MCP connection registry is idempotent and rejects unsupported clients or malformed tunnel ids', async () => {
  const f = await fixture();
  try {
    const first = await f.registry.add('cursor');
    const second = await f.registry.add('cursor');
    assert.equal(first.addedAt, second.addedAt);
    assert.equal(f.registry.list().length, 1);

    await assert.rejects(() => f.registry.add('unknown'), /Cliente MCP inválido/);
    await assert.rejects(() => f.registry.markConfigured('chatgpt', { tunnelId: 'bad' }), /Tunnel ID inválido/);
    assert.equal(await f.registry.remove('cursor'), true);
    assert.equal(await f.registry.remove('cursor'), false);
  } finally {
    await f.cleanup();
  }
});

test('MCP connection registry ignores malformed persisted records and keeps the newest duplicate', async () => {
  const f = await fixture();
  try {
    await f.storage.write('mcp-connections.json', [
      { clientId: 'codex', setupState: 'added', addedAt: 10, updatedAt: 20 },
      { clientId: 'codex', setupState: 'configured', addedAt: 10, updatedAt: 30, configuredAt: 30 },
      { clientId: 'bad', setupState: 'added', addedAt: 1, updatedAt: 1 },
      { clientId: 'cursor', setupState: 'broken', addedAt: 1, updatedAt: 1 },
    ]);
    const restored = new McpConnectionRegistry(f.storage);
    await restored.init();
    const records = restored.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].clientId, 'codex');
    assert.equal(records[0].setupState, 'configured');
  } finally {
    await f.cleanup();
  }
});
