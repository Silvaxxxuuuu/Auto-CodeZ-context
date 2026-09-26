import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { OperationalLedgerPersistence, OperationalLedgerStore } from '../src/operational-ledger-store';
import type { OperationalLedgerEvent } from '../src/operational-ledger';

function secureAdapter(): SecureStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encrypt: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decrypt: (value) => {
      const decoded = value.toString('utf8');
      if (!decoded.startsWith('encrypted:')) throw new Error('Invalid encrypted payload.');
      return decoded.slice('encrypted:'.length);
    },
  };
}

function events(): OperationalLedgerEvent[] {
  return [
    {
      eventId: 'event-a',
      sequence: 1,
      timestamp: 1000,
      actor: 'agent',
      category: 'tool',
      state: 'running',
      summary: 'Executando tool.',
      chatId: 'chat-a',
      runId: 'run-a',
      toolCallId: 'call-a',
      toolName: 'plugin_call',
    },
    {
      eventId: 'event-b',
      sequence: 2,
      timestamp: 1200,
      actor: 'plugin',
      category: 'artifact',
      state: 'success',
      summary: 'Artifact produzido.',
      pluginId: 'test.plugin',
      jobId: 'job-a',
      artifactIds: ['artifact-a'],
      details: { kind: 'image', bytes: 128 },
    },
  ];
}

test('operational ledger store persists encrypted events and restores metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-ledger-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new OperationalLedgerStore(storage);
    await store.save(events());

    const raw = await readFile(path.join(root, 'operational-ledger.json'), 'utf8');
    assert.equal(raw.includes('Executando tool'), false);
    assert.equal(raw.includes('artifact-a'), false);
    assert.deepEqual(await store.load(), events());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operational ledger store filters malformed persisted events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-ledger-invalid-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    await storage.write('operational-ledger.json', {
      version: 1,
      events: [
        ...events(),
        { eventId: '', sequence: 0, timestamp: -1, actor: 'unknown', category: 'bad', state: 'bad', summary: '' },
      ],
    });
    const store = new OperationalLedgerStore(storage);
    assert.deepEqual(await store.load(), events());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operational ledger persistence serializes snapshots in order and keeps latest view', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-ledger-queue-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new OperationalLedgerStore(storage);
    const persistence = new OperationalLedgerPersistence(store);
    persistence.schedule(events().slice(0, 1));
    persistence.schedule(events());
    await persistence.flush();
    assert.deepEqual(await store.load(), events());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operational ledger persistence fails closed without secure storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-ledger-secure-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new OperationalLedgerStore(storage);
    await assert.rejects(store.save(events()), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
