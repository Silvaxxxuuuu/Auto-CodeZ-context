import test from 'node:test';
import assert from 'node:assert/strict';
import type { LocalStorage } from '../src/core/storage';
import { SecretVault } from '../src/account/secret-vault';
import { SyncQueue } from '../src/account/sync-queue';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  async read<T>(name: string, fallback: T): Promise<T> {
    const value = this.values.get(name);
    return value === undefined ? fallback : JSON.parse(value) as T;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, JSON.stringify(value));
  }

  async readEncrypted(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async writeEncrypted(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
}

test('SyncQueue serializes concurrent mutations and preserves pending work', async () => {
  const storage = new MemoryStorage();
  const queue = new SyncQueue(storage as unknown as LocalStorage);

  const [first, second] = await Promise.all([
    queue.enqueue({ entityType: 'chat', entityId: 'chat-1', operation: 'update', deviceId: 'device-a', baseRevision: 2, localRevision: 3, payload: { title: 'A' }, now: 100 }),
    queue.enqueue({ entityType: 'configuration', entityId: 'config', operation: 'update', deviceId: 'device-a', baseRevision: 4, localRevision: 5, payload: { theme: 'dark' }, now: 101 }),
  ]);

  const items = await queue.list();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.id).sort(), [first.id, second.id].sort());
  assert.ok(items.every((item) => item.status === 'pending'));

  await queue.markInFlight(first.id, 200);
  await queue.markPending(first.id, 'offline', 300);
  const updated = (await queue.list()).find((item) => item.id === first.id);
  assert.equal(updated?.status, 'pending');
  assert.equal(updated?.attempts, 1);
  assert.equal(updated?.nextAttemptAt, 300);
  assert.equal(updated?.lastError, 'offline');
});

test('SecretVault stores values through encrypted storage and keeps secret values out of metadata', async () => {
  const storage = new MemoryStorage();
  const vault = new SecretVault(storage as unknown as LocalStorage);

  await vault.set('auth.refresh-token', 'super-secret');
  assert.equal(await vault.get('auth.refresh-token'), 'super-secret');

  const metadata = await vault.listMetadata();
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0]?.key, 'auth.refresh-token');
  assert.equal(typeof metadata[0]?.updatedAt, 'number');

  assert.equal(await vault.remove('auth.refresh-token'), true);
  assert.equal(await vault.get('auth.refresh-token'), null);
});
