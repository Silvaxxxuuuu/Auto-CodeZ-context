import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import type { ProjectRecord } from '../src/ai/types';

async function createWorkspace(): Promise<{ root: string; runtime: WorkspaceRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-test-'));
  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Test Project',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const runtime = new WorkspaceRuntime(async () => [project]);
  return { root, runtime, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('resolve accepts paths inside the project', async () => {
  const workspace = await createWorkspace();
  try {
    const resolved = await workspace.runtime.resolve('project-test', 'src/index.ts');
    const realRoot = await fs.realpath(workspace.root);
    assert.equal(resolved, path.resolve(realRoot, 'src', 'index.ts'));
  } finally {
    await workspace.cleanup();
  }
});

test('resolve rejects parent traversal outside the project', async () => {
  const workspace = await createWorkspace();
  try {
    await assert.rejects(
      workspace.runtime.resolve('project-test', path.join('..', 'outside.txt')),
      /caminho fora do workspace/,
    );
  } finally {
    await workspace.cleanup();
  }
});

test('resolve rejects a symlink that points outside the workspace', async () => {
  const workspace = await createWorkspace();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(workspace.root, 'linked'));
    await assert.rejects(
      workspace.runtime.resolve('project-test', path.join('linked', 'secret.txt')),
      /caminho fora do workspace/,
    );
  } finally {
    await workspace.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('createFile does not overwrite an existing file', async () => {
  const workspace = await createWorkspace();
  try {
    await workspace.runtime.createFile('project-test', 'notes.txt', 'first');
    await assert.rejects(workspace.runtime.createFile('project-test', 'notes.txt', 'second'), /EEXIST/);
    assert.equal(await workspace.runtime.readFile('project-test', 'notes.txt'), 'first');
  } finally {
    await workspace.cleanup();
  }
});

test('writeFile creates parent directories and persists UTF-8 content', async () => {
  const workspace = await createWorkspace();
  try {
    await workspace.runtime.writeFile('project-test', 'nested/file.txt', 'Olá, Auto CodeZ');
    assert.equal(await workspace.runtime.readFile('project-test', 'nested/file.txt'), 'Olá, Auto CodeZ');
    assert.equal(await workspace.runtime.exists('project-test', 'nested/file.txt'), true);
  } finally {
    await workspace.cleanup();
  }
});

test('readFile rejects files larger than the text limit', async () => {
  const workspace = await createWorkspace();
  try {
    const large = Buffer.alloc(2 * 1024 * 1024 + 1, 'a');
    await fs.writeFile(path.join(workspace.root, 'large.txt'), large);
    await assert.rejects(workspace.runtime.readFile('project-test', 'large.txt'), /excede o limite/);
  } finally {
    await workspace.cleanup();
  }
});

test('writeFile rejects content larger than the text limit before touching the filesystem', async () => {
  const workspace = await createWorkspace();
  try {
    const large = 'a'.repeat(2 * 1024 * 1024 + 1);
    await assert.rejects(workspace.runtime.writeFile('project-test', 'large.txt', large), /excede o limite/);
    assert.equal(await workspace.runtime.exists('project-test', 'large.txt'), false);
  } finally {
    await workspace.cleanup();
  }
});

test('writeFile enforces the byte limit for multibyte UTF-8 content', async () => {
  const workspace = await createWorkspace();
  try {
    const content = 'é'.repeat(2 * 1024 * 1024);
    await assert.rejects(workspace.runtime.writeFile('project-test', 'utf8.txt', content), /excede o limite/);
    assert.equal(await workspace.runtime.exists('project-test', 'utf8.txt'), false);
  } finally {
    await workspace.cleanup();
  }
});

test('renameFile refuses to replace an existing destination', async () => {
  const workspace = await createWorkspace();
  try {
    await workspace.runtime.createFile('project-test', 'old.txt', 'old');
    await workspace.runtime.createFile('project-test', 'new.txt', 'new');
    await assert.rejects(workspace.runtime.renameFile('project-test', 'old.txt', 'new.txt'), /O destino já existe/);
    assert.equal(await workspace.runtime.readFile('project-test', 'old.txt'), 'old');
    assert.equal(await workspace.runtime.readFile('project-test', 'new.txt'), 'new');
  } finally {
    await workspace.cleanup();
  }
});

test('deleteFile and renameFile stay inside the workspace', async () => {
  const workspace = await createWorkspace();
  try {
    await workspace.runtime.createFile('project-test', 'old.txt', 'content');
    await workspace.runtime.renameFile('project-test', 'old.txt', 'new.txt');
    assert.equal(await workspace.runtime.exists('project-test', 'old.txt'), false);
    assert.equal(await workspace.runtime.readFile('project-test', 'new.txt'), 'content');
    await workspace.runtime.deleteFile('project-test', 'new.txt');
    assert.equal(await workspace.runtime.exists('project-test', 'new.txt'), false);
  } finally {
    await workspace.cleanup();
  }
});

test('searchFiles ignores generated and dependency directories', async () => {
  const workspace = await createWorkspace();
  try {
    await workspace.runtime.createFile('project-test', 'src/target.ts', 'content');
    await workspace.runtime.createFile('project-test', 'node_modules/target.ts', 'dependency');
    await workspace.runtime.createFile('project-test', 'dist/target.js', 'generated');
    const results = await workspace.runtime.searchFiles('project-test', 'target');
    assert.deepEqual(results, [path.join('src', 'target.ts')]);
  } finally {
    await workspace.cleanup();
  }
});

test('searchFiles rejects an empty query', async () => {
  const workspace = await createWorkspace();
  try {
    await assert.rejects(workspace.runtime.searchFiles('project-test', '   '), /A busca precisa conter um texto/);
  } finally {
    await workspace.cleanup();
  }
});
