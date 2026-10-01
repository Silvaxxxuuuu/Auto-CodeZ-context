import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RollbackBlobStore } from '../src/agent-core/rollback-blob-store';
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

test('RollbackBlobStore is content-addressed, encrypted at rest and deduplicates by reference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocodez-rollback-blobs-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new RollbackBlobStore(storage);
    const content = 'const token = "private-before-state";';

    const first = await store.putText(content);
    const second = await store.putText(content);

    assert.equal(first, second);
    assert.match(first, /^blob:sha256:[a-f0-9]{64}$/);
    assert.equal(await store.getText(first), content);
    assert.equal(await store.has(first), true);

    const hash = first.slice('blob:sha256:'.length);
    const raw = await readFile(path.join(root, `agent-core-rollback-${hash}.blob`), 'utf8');
    assert.equal(raw.includes('private-before-state'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RollbackBlobStore verifies persisted content against its SHA-256 reference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocodez-rollback-blobs-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new RollbackBlobStore(storage);
    const ref = await store.putText('before');
    const hash = ref.slice('blob:sha256:'.length);

    await writeFile(
      path.join(root, `agent-core-rollback-${hash}.blob`),
      Buffer.from('encrypted:tampered', 'utf8').toString('base64'),
      'utf8',
    );

    await assert.rejects(() => store.getText(ref), /corrompido|adulterado/i);
    await assert.rejects(() => store.has(ref), /corrompido|adulterado/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RollbackBlobStore rejects malformed references and removes blobs explicitly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocodez-rollback-blobs-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new RollbackBlobStore(storage);
    const ref = await store.putText('temporary');

    await assert.rejects(() => store.getText('../escape'), /Referência de rollback inválida/);
    await assert.rejects(() => store.getText('blob:sha256:not-a-hash'), /Hash de rollback inválido/);

    await store.remove(ref);
    assert.equal(await store.has(ref), false);
    await assert.rejects(() => store.getText(ref), /não encontrado/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RollbackBlobStore fails closed when OS secure storage is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocodez-rollback-blobs-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new RollbackBlobStore(storage);
    await assert.rejects(() => store.putText('secret-before-state'), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RollbackBlobStore refForText matches persisted reference deterministically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocodez-rollback-blobs-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new RollbackBlobStore(storage);
    const content = 'same bytes, same reference';
    assert.equal(RollbackBlobStore.refForText(content), await store.putText(content));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
