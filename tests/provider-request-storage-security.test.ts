import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProviderRequestJournal } from '../src/ai/provider-request-journal';
import type { AIRequest, AIResponse } from '../src/ai/types';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';

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

const request: AIRequest = {
  providerId: 'openai',
  model: 'model-test',
  messages: [{ role: 'user', content: 'private user request' }],
  intelligence: 'normal',
  toolsEnabled: false,
};

const response: AIResponse = {
  providerId: 'openai',
  model: 'model-test',
  content: 'private source code response',
};

test('provider request journal persists recovery data encrypted and restores completed responses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-provider-journal-'));
  try {
    const firstStorage = new LocalStorage(root, secureAdapter());
    await firstStorage.init();
    const firstJournal = new ProviderRequestJournal(firstStorage);
    await firstJournal.init();

    const created = await firstJournal.begin(request, 'credential-scope');
    await firstJournal.complete(created.requestId, response);

    const raw = await readFile(path.join(root, 'provider-requests.json'), 'utf8');
    assert.equal(raw.includes('private source code response'), false);
    assert.equal(raw.includes('private user request'), false);

    const secondStorage = new LocalStorage(root, secureAdapter());
    const secondJournal = new ProviderRequestJournal(secondStorage);
    await secondJournal.init();
    const recovered = await secondJournal.begin(request, 'credential-scope');

    assert.equal(recovered.requestId, created.requestId);
    assert.deepEqual(recovered.cachedResponse, response);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider request journal fails closed when secure storage is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-provider-journal-'));
  try {
    const adapter: SecureStorageAdapter = {
      ...secureAdapter(),
      isEncryptionAvailable: () => false,
    };
    const storage = new LocalStorage(root, adapter);
    await storage.init();
    const journal = new ProviderRequestJournal(storage);
    await journal.init();

    await assert.rejects(
      journal.begin(request, 'credential-scope'),
      /armazenamento seguro indisponível/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
