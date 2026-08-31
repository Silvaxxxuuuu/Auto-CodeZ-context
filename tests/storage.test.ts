import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';

function createSecureAdapter(): SecureStorageAdapter {
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

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-storage-'));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('secure values are persisted outside public JSON and survive a new storage instance', async () => {
  await withTempRoot(async (root) => {
    const secure = createSecureAdapter();
    const first = new LocalStorage(root, secure);
    await first.init();

    const secret = 'sk-test-provider-secret-123';
    await first.write('providers.json', [{ id: 'openai', enabled: true }]);
    await first.writeEncrypted('provider-keys.dat', JSON.stringify({ openai: secret }));

    const publicFile = await readFile(path.join(root, 'providers.json'), 'utf8');
    const encryptedFile = await readFile(path.join(root, 'provider-keys.dat'), 'utf8');
    assert.equal(publicFile.includes(secret), false);
    assert.equal(encryptedFile.includes(secret), false);

    const second = new LocalStorage(root, secure);
    assert.equal(await second.readEncrypted('provider-keys.dat'), JSON.stringify({ openai: secret }));
    assert.deepEqual(await second.read('providers.json', []), [{ id: 'openai', enabled: true }]);
  });
});

test('secure storage rejects writes when encryption is unavailable', async () => {
  await withTempRoot(async (root) => {
    const secure: SecureStorageAdapter = {
      ...createSecureAdapter(),
      isEncryptionAvailable: () => false,
    };
    const storage = new LocalStorage(root, secure);
    await assert.rejects(
      () => storage.writeEncrypted('provider-keys.dat', 'secret'),
      /armazenamento seguro indisponível/i,
    );
  });
});

test('secure storage returns null only for a missing encrypted file', async () => {
  await withTempRoot(async (root) => {
    const storage = new LocalStorage(root, createSecureAdapter());
    await storage.init();
    assert.equal(await storage.readEncrypted('missing.dat'), null);
  });
});

test('storage rejects traversal names', async () => {
  await withTempRoot(async (root) => {
    const storage = new LocalStorage(root, createSecureAdapter());
    await assert.rejects(() => storage.write('../outside.json', { unsafe: true }), /Nome de armazenamento inválido/);
    await assert.rejects(() => storage.readEncrypted('../outside.dat'), /Nome de armazenamento inválido/);
  });
});

test('failed encrypted writes leave no temporary files behind', async () => {
  await withTempRoot(async (root) => {
    const secure: SecureStorageAdapter = {
      ...createSecureAdapter(),
      encrypt: () => {
        throw new Error('encryption failure');
      },
    };
    const storage = new LocalStorage(root, secure);
    await assert.rejects(() => storage.writeEncrypted('provider-keys.dat', 'secret'), /encryption failure/);
    assert.deepEqual(await readdir(root), []);
  });
});
