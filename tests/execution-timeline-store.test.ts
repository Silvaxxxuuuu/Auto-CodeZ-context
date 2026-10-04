import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionTimelinePersistence, ExecutionTimelineStore } from '../src/execution-timeline-store';
import type { ExecutionTimelineEvent } from '../src/execution-timeline';

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

function events(): ExecutionTimelineEvent[] {
  return [
    { sequence: 1, chatId: 'chat-a', runId: 'run-a', at: 1000, type: 'started', state: 'running' },
    { sequence: 2, chatId: 'chat-a', runId: 'run-a', at: 1200, type: 'tool_changed', state: 'running', currentTool: 'read_file' },
    { sequence: 3, chatId: 'chat-a', runId: 'run-a', at: 1400, type: 'error', state: 'failed', error: 'caminho privado C:/Users/User/project' },
  ];
}

test('timeline é persistida criptografada e restaurada', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-timeline-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionTimelineStore(storage);
    await store.save(events());

    const raw = await readFile(path.join(root, 'execution-timeline.json'), 'utf8');
    assert.equal(raw.includes('read_file'), false);
    assert.equal(raw.includes('C:/Users/User/project'), false);
    assert.deepEqual(await store.load(), events());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeline persiste baseline recovered com startedAt original', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-timeline-recovery-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionTimelineStore(storage);
    const recovered: ExecutionTimelineEvent[] = [{
      sequence: 1,
      chatId: 'chat-a',
      runId: 'run-a',
      at: 5000,
      type: 'recovered',
      state: 'interrupted',
      startedAt: 1000,
    }];

    await store.save(recovered);
    assert.deepEqual(await store.load(), recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timeline ignora eventos persistidos inválidos', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-timeline-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    await storage.write('execution-timeline.json', {
      version: 1,
      events: [
        ...events(),
        { sequence: 0, chatId: '', runId: '', at: -1, type: 'unknown' },
        { sequence: 4, chatId: 'chat-a', runId: 'run-a', at: 5000, type: 'recovered', state: 'interrupted' },
      ],
    });
    const store = new ExecutionTimelineStore(storage);
    assert.deepEqual(await store.load(), events());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fila de persistência da timeline preserva a visão mais recente', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-timeline-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionTimelineStore(storage);
    const persistence = new ExecutionTimelinePersistence(store);
    persistence.schedule(events().slice(0, 1));
    persistence.schedule(events().slice(0, 2));
    persistence.schedule(events());
    await persistence.flush();

    assert.deepEqual(await store.load(), events());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência da timeline falha fechada sem armazenamento seguro', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-timeline-security-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionTimelineStore(storage);
    await assert.rejects(store.save(events()), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
