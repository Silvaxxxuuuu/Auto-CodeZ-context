import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import type { ShadowWorkspaceSnapshot } from '../src/agent/shadow-workspace';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { reconcileShadowWorkspaceBootstrap } from '../src/execution-shadow-workspace-bootstrap';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';
import {
  ExecutionShadowWorkspacePersistence,
  ExecutionShadowWorkspaceStore,
} from '../src/execution-shadow-workspace-store';

function memoryStorage(initial: unknown) {
  let value = structuredClone(initial);
  return {
    read: async <T>(_name: string, fallback: T): Promise<T> => structuredClone(value ?? fallback) as T,
    write: async <T>(_name: string, next: T): Promise<void> => {
      value = structuredClone(next);
    },
  };
}

function snapshot(): ShadowWorkspaceSnapshot {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    createdAt: 100,
    updatedAt: 110,
    status: 'active',
    changes: [{
      path: 'a.txt',
      type: 'modified',
      before: 'base',
      after: 'legacy-shadow',
      addedLines: 1,
      removedLines: 1,
    }],
  };
}

async function fixture(initialSnapshots: ShadowWorkspaceSnapshot[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-shadow-retirement-bootstrap-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
  const project: ProjectRecord = {
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const storage = memoryStorage({ version: 1, snapshots: initialSnapshots });
  const store = new ExecutionShadowWorkspaceStore(storage as never);
  const persistence = new ExecutionShadowWorkspacePersistence(store);
  const runtime = new ExecutionShadowWorkspaceRuntime(workspace);
  runtime.subscribe((snapshots) => persistence.schedule(snapshots));

  return {
    root,
    store,
    persistence,
    runtime,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('bootstrap removes orphan legacy shadow snapshots from persistent storage', async () => {
  const legacy = snapshot();
  const f = await fixture([legacy]);
  try {
    const reconciled = reconcileShadowWorkspaceBootstrap(
      await f.store.load(),
      [],
      [],
    );
    assert.deepEqual(reconciled, []);

    f.runtime.restore(reconciled);
    await f.persistence.flush();

    assert.deepEqual(f.runtime.list(), []);
    assert.deepEqual(await f.store.load(), []);
  } finally {
    await f.cleanup();
  }
});

test('recoverable legacy shadow survives bootstrap and is removed from storage after discard', async () => {
  const legacy = snapshot();
  const f = await fixture([legacy]);
  try {
    const reconciled = reconcileShadowWorkspaceBootstrap(
      await f.store.load(),
      [],
      [{ chatId: 'chat-a', runId: 'run-a' }],
    );
    assert.equal(reconciled.length, 1);

    f.runtime.restore(reconciled);
    await f.persistence.flush();

    assert.equal(f.runtime.list().length, 1);
    assert.equal((await f.store.load()).length, 1);

    const discarded = f.runtime.discard('chat-a', 'run-a');
    assert.equal(discarded.status, 'discarded');
    await f.persistence.flush();

    assert.deepEqual(f.runtime.list(), []);
    assert.deepEqual(await f.store.load(), []);
    assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'base');
  } finally {
    await f.cleanup();
  }
});
