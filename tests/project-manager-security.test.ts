import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectManager } from '../src/core/project-manager';
import { LocalStorage } from '../src/core/storage';

class TestStorage extends LocalStorage {
  write<T>(_name: string, _value: T): Promise<void> {
    return Promise.resolve();
  }
}

async function createProjectManager(): Promise<{ root: string; manager: ProjectManager; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-project-'));
  const manager = new ProjectManager(new TestStorage());
  await manager.create('Test Project', root);
  return { root, manager, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('writeFile rejects an existing symlink target outside the workspace', async () => {
  const workspace = await createProjectManager();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-project-outside-'));
  try {
    const outsideFile = path.join(outside, 'secret.txt');
    const linkedFile = path.join(workspace.root, 'linked.txt');
    await fs.writeFile(outsideFile, 'original', 'utf8');
    await fs.symlink(outsideFile, linkedFile);

    await assert.rejects(workspace.manager.writeFile(linkedFile, 'overwritten'), /arquivo simbólico fora do workspace/);
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'original');
  } finally {
    await workspace.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('writeFile rejects a symlinked parent that points outside the workspace', async () => {
  const workspace = await createProjectManager();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-project-parent-outside-'));
  try {
    const linkedDirectory = path.join(workspace.root, 'linked-directory');
    const outsideFile = path.join(outside, 'secret.txt');
    await fs.writeFile(outsideFile, 'original', 'utf8');
    await fs.symlink(outside, linkedDirectory, 'junction');

    await assert.rejects(workspace.manager.writeFile(path.join(linkedDirectory, 'created.txt'), 'blocked'), /diretório simbólico fora do workspace/);
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'original');
    assert.equal(await fs.stat(path.join(outside, 'created.txt')).then(() => true, () => false), false);
  } finally {
    await workspace.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('writeFile accepts an existing regular file inside the workspace', async () => {
  const workspace = await createProjectManager();
  try {
    const filePath = path.join(workspace.root, 'safe.txt');
    await fs.writeFile(filePath, 'before', 'utf8');
    await workspace.manager.writeFile(filePath, 'after');
    assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
  } finally {
    await workspace.cleanup();
  }
});

test('scan does not traverse a directory symlink outside the workspace', async () => {
  const workspace = await createProjectManager();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-project-scan-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    const linkedDirectory = path.join(workspace.root, 'external-directory');
    await fs.symlink(outside, linkedDirectory, 'junction');

    const entries = await workspace.manager.scan(workspace.root);
    assert.equal(entries.some((entry) => entry.relativePath === path.join('external-directory', 'secret.txt')), false);
    assert.equal(entries.some((entry) => entry.path === linkedDirectory), true);
  } finally {
    await workspace.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});
