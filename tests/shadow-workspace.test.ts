import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShadowWorkspaceTransaction, type ShadowWorkspaceBase } from '../src/agent/shadow-workspace';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
  }
  const workspace = new WorkspaceRuntime(async () => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }]);
  return {
    root,
    workspace,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

function transaction(base: ShadowWorkspaceBase, now: () => number = () => 100) {
  return new ShadowWorkspaceTransaction(base, { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' }, undefined, now);
}

test('alteração permanece isolada até commit e depois é publicada', async () => {
  const fx = await fixture({ 'a.txt': 'old' });
  try {
    const shadow = transaction(fx.workspace);
    await shadow.writeFile('project-a', 'a.txt', 'new');

    assert.equal(await shadow.readFile('project-a', 'a.txt'), 'new');
    assert.equal(await readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'old');
    assert.equal(shadow.listChanges().length, 1);

    const committed = await shadow.commit();
    assert.equal(committed.status, 'committed');
    assert.equal(await readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'new');
  } finally {
    await fx.cleanup();
  }
});

test('discard encerra a transação sem tocar no workspace real', async () => {
  const fx = await fixture({ 'a.txt': 'old' });
  try {
    const shadow = transaction(fx.workspace);
    await shadow.writeFile('project-a', 'a.txt', 'shadow');
    await shadow.createFile('project-a', 'new.txt', 'created');

    const discarded = shadow.discard();
    assert.equal(discarded.status, 'discarded');
    assert.equal(await readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'old');
    assert.equal(await fx.workspace.exists('project-a', 'new.txt'), false);
    await assert.rejects(() => shadow.writeFile('project-a', 'a.txt', 'later'), /não está mais ativo/i);
  } finally {
    await fx.cleanup();
  }
});

test('create delete e rename são aplicados somente durante commit e preservam ordem', async () => {
  const fx = await fixture({ 'remove.txt': 'remove-me', 'rename.txt': 'rename-me' });
  try {
    const shadow = transaction(fx.workspace);
    await shadow.createFile('project-a', 'created.txt', 'created');
    await shadow.deleteFile('project-a', 'remove.txt');
    await shadow.renameFile('project-a', 'rename.txt', 'nested/renamed.txt');
    await shadow.writeFile('project-a', 'nested/renamed.txt', 'renamed-and-edited');

    assert.equal(await fx.workspace.exists('project-a', 'created.txt'), false);
    assert.equal(await fx.workspace.exists('project-a', 'remove.txt'), true);
    assert.equal(await fx.workspace.exists('project-a', 'rename.txt'), true);

    await shadow.commit();

    assert.equal(await fx.workspace.readFile('project-a', 'created.txt'), 'created');
    assert.equal(await fx.workspace.exists('project-a', 'remove.txt'), false);
    assert.equal(await fx.workspace.exists('project-a', 'rename.txt'), false);
    assert.equal(await fx.workspace.readFile('project-a', 'nested/renamed.txt'), 'renamed-and-edited');
  } finally {
    await fx.cleanup();
  }
});

test('mudança externa bloqueia toda publicação antes da primeira mutação real', async () => {
  const fx = await fixture({ 'a.txt': 'a-old', 'b.txt': 'b-old' });
  try {
    const shadow = transaction(fx.workspace);
    await shadow.writeFile('project-a', 'a.txt', 'a-shadow');
    await shadow.writeFile('project-a', 'b.txt', 'b-shadow');
    await fx.workspace.writeFile('project-a', 'a.txt', 'a-external');

    await assert.rejects(() => shadow.commit(), /mudou fora do Shadow Workspace/i);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'a-external');
    assert.equal(await fx.workspace.readFile('project-a', 'b.txt'), 'b-old');
    assert.equal(shadow.snapshot().status, 'active');
  } finally {
    await fx.cleanup();
  }
});

test('falha parcial durante commit recompõe alterações já publicadas', async () => {
  const fx = await fixture({ 'a.txt': 'a-old', 'b.txt': 'b-old' });
  try {
    let failed = false;
    const base: ShadowWorkspaceBase = {
      exists: (projectId, requestedPath) => fx.workspace.exists(projectId, requestedPath),
      readFile: (projectId, requestedPath) => fx.workspace.readFile(projectId, requestedPath),
      writeFile: async (projectId, requestedPath, content) => {
        if (requestedPath === 'b.txt' && !failed) {
          failed = true;
          throw new Error('injected commit failure');
        }
        await fx.workspace.writeFile(projectId, requestedPath, content);
      },
      createFile: (projectId, requestedPath, content) => fx.workspace.createFile(projectId, requestedPath, content),
      deleteFile: (projectId, requestedPath) => fx.workspace.deleteFile(projectId, requestedPath),
      renameFile: (projectId, from, to) => fx.workspace.renameFile(projectId, from, to),
      searchFiles: (projectId, query) => fx.workspace.searchFiles(projectId, query),
    };
    const shadow = transaction(base);
    await shadow.writeFile('project-a', 'a.txt', 'a-shadow');
    await shadow.writeFile('project-a', 'b.txt', 'b-shadow');

    await assert.rejects(() => shadow.commit(), /workspace real foi recomposto/i);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'a-old');
    assert.equal(await fx.workspace.readFile('project-a', 'b.txt'), 'b-old');
    assert.equal(shadow.snapshot().status, 'active');
  } finally {
    await fx.cleanup();
  }
});

test('searchFiles projeta criações e exclusões do overlay sem alterar a base', async () => {
  const fx = await fixture({ 'old-item.txt': 'old', 'keep.txt': 'keep' });
  try {
    const shadow = transaction(fx.workspace);
    await shadow.deleteFile('project-a', 'old-item.txt');
    await shadow.createFile('project-a', 'nested/new-item.txt', 'new');

    assert.deepEqual(await shadow.searchFiles('project-a', 'item'), ['nested/new-item.txt']);
    assert.deepEqual(await fx.workspace.searchFiles('project-a', 'item'), ['old-item.txt']);
  } finally {
    await fx.cleanup();
  }
});

test('transação rejeita outro projeto e snapshots são cópias defensivas', async () => {
  const fx = await fixture({ 'a.txt': 'old' });
  try {
    let time = 100;
    const shadow = transaction(fx.workspace, () => time++);
    await assert.rejects(() => shadow.readFile('project-b', 'a.txt'), /outro projeto/i);
    await shadow.writeFile('project-a', 'a.txt', 'new');

    const snapshot = shadow.snapshot();
    snapshot.changes[0].after = 'tampered';
    assert.equal(shadow.snapshot().changes[0].after, 'new');

    await shadow.commit();
    await assert.rejects(() => shadow.commit(), /não está mais ativo/i);
  } finally {
    await fx.cleanup();
  }
});
