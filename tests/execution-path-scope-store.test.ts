import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage } from '../src/core/storage';
import { ExecutionPathScopePersistence, ExecutionPathScopeStore } from '../src/execution-path-scope-store';
import type { ExecutionPathScopeSnapshot } from '../src/execution-path-scope';

function snapshot(input: Partial<ExecutionPathScopeSnapshot> = {}): ExecutionPathScopeSnapshot {
  return {
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    projectId: input.projectId ?? 'project-a',
    allowedPaths: input.allowedPaths ?? ['src'],
    configuredAt: input.configuredAt ?? 1000,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-path-scope-store-'));
  const storage = new LocalStorage(root);
  await storage.init();
  return { root, storage, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('store salva e carrega snapshots normalizados', async () => {
  const item = await fixture();
  try {
    const store = new ExecutionPathScopeStore(item.storage);
    await store.save([snapshot({ allowedPaths: ['./src', 'tests\\unit', 'src'] })]);
    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].allowedPaths, ['src', 'tests/unit']);
  } finally {
    await item.cleanup();
  }
});

test('store ignora registros inválidos e mantém o snapshot mais recente por execução', async () => {
  const item = await fixture();
  try {
    await item.storage.write('execution-path-scopes.json', {
      version: 1,
      snapshots: [
        snapshot({ configuredAt: 1000, allowedPaths: ['src'] }),
        snapshot({ configuredAt: 2000, allowedPaths: ['tests'] }),
        { chatId: '', runId: 'broken', projectId: 'project-a', allowedPaths: ['src'], configuredAt: 3000 },
      ],
    });
    const loaded = await new ExecutionPathScopeStore(item.storage).load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].configuredAt, 2000);
    assert.deepEqual(loaded[0].allowedPaths, ['tests']);
  } finally {
    await item.cleanup();
  }
});

test('persistence serializa writes e flush expõe falhas', async () => {
  const writes: ExecutionPathScopeSnapshot[][] = [];
  const store = {
    save: async (snapshots: ExecutionPathScopeSnapshot[]) => {
      writes.push(snapshots.map((item) => ({ ...item, allowedPaths: [...item.allowedPaths] })));
    },
  } as ExecutionPathScopeStore;
  const persistence = new ExecutionPathScopePersistence(store);
  const first = snapshot({ runId: 'run-a' });
  const second = snapshot({ runId: 'run-b' });
  persistence.schedule([first]);
  persistence.schedule([first, second]);
  await persistence.flush();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].map((item) => item.runId), ['run-a', 'run-b']);
});
