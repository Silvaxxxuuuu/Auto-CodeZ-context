import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import {
  ElectronInstancePlatformAdapter,
  type ElectronInstancePlatformDependencies,
} from '../src/agent/electron-instance-platform';

async function fixture(overrides: Partial<ElectronInstancePlatformDependencies> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-electron-instance-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.txt'), 'hello', 'utf8');
  await fs.writeFile(path.join(root, 'tool.exe'), 'binary-placeholder', 'utf8');
  const openedExternal: string[] = [];
  const openedPaths: string[] = [];
  const previews: string[] = [];
  const project: ProjectRecord = {
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  const dependencies: ElectronInstancePlatformDependencies = {
    openExternal: async (url) => { openedExternal.push(url); },
    openPath: async (target) => { openedPaths.push(target); return ''; },
    openPreview: async (input) => {
      previews.push(input.target);
      return {
        canFocus: true,
        canClose: true,
        focus: () => undefined,
        close: () => undefined,
        isOpen: () => true,
      };
    },
    ...overrides,
  };
  return {
    root,
    openedExternal,
    openedPaths,
    previews,
    adapter: new ElectronInstancePlatformAdapter(async () => [project], dependencies),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('Electron adapter opens preview through the controlled preview surface', async () => {
  const f = await fixture();
  try {
    const handle = await f.adapter.open({
      instanceId: 'preview-1',
      projectId: 'project-a',
      kind: 'preview',
      target: 'http://localhost:5173',
    });
    assert.equal(handle.canFocus, true);
    assert.equal(handle.canClose, true);
    assert.deepEqual(f.previews, ['http://localhost:5173/']);
    assert.deepEqual(f.openedExternal, []);
    assert.deepEqual(f.openedPaths, []);
  } finally {
    await f.cleanup();
  }
});

test('Electron adapter opens URL externally without claiming lifecycle control', async () => {
  const f = await fixture();
  try {
    const handle = await f.adapter.open({
      instanceId: 'url-1',
      projectId: 'project-a',
      kind: 'url',
      target: 'https://example.com/docs',
    });
    assert.deepEqual(f.openedExternal, ['https://example.com/docs']);
    assert.equal(handle.canFocus, false);
    assert.equal(handle.canClose, false);
    assert.equal(handle.focus, undefined);
    assert.equal(handle.close, undefined);
  } finally {
    await f.cleanup();
  }
});

test('Electron adapter resolves file, folder and application targets inside the workspace', async () => {
  const f = await fixture();
  try {
    for (const [kind, target] of [
      ['file', 'src/app.txt'],
      ['folder', 'src'],
      ['application', 'tool.exe'],
    ] as const) {
      const handle = await f.adapter.open({
        instanceId: `${kind}-1`,
        projectId: 'project-a',
        kind,
        target,
      });
      assert.equal(handle.canFocus, false);
      assert.equal(handle.canClose, false);
    }

    assert.deepEqual(f.openedPaths, [
      await fs.realpath(path.join(f.root, 'src', 'app.txt')),
      await fs.realpath(path.join(f.root, 'src')),
      await fs.realpath(path.join(f.root, 'tool.exe')),
    ]);
  } finally {
    await f.cleanup();
  }
});

test('Electron adapter blocks workspace escape before shell effects', async () => {
  const f = await fixture();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-electron-instance-outside-'));
  try {
    const outside = path.join(outsideRoot, 'outside.txt');
    await fs.writeFile(outside, 'outside', 'utf8');

    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'escape-1',
        projectId: 'project-a',
        kind: 'file',
        target: outside,
      }),
      /fora do workspace autorizado/i,
    );
    assert.deepEqual(f.openedPaths, []);
  } finally {
    await f.cleanup();
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('Electron adapter validates target kind and missing paths', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'wrong-folder',
        projectId: 'project-a',
        kind: 'folder',
        target: 'src/app.txt',
      }),
      /não é uma pasta/i,
    );
    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'wrong-file',
        projectId: 'project-a',
        kind: 'file',
        target: 'src',
      }),
      /não é um arquivo/i,
    );
    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'missing',
        projectId: 'project-a',
        kind: 'file',
        target: 'missing.txt',
      }),
      /não existe no workspace/i,
    );
  } finally {
    await f.cleanup();
  }
});

test('Electron adapter surfaces shell openPath errors and rejects unsafe URL protocols', async () => {
  const f = await fixture({
    openPath: async () => 'No application is associated with the specified file',
  });
  try {
    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'path-error',
        projectId: 'project-a',
        kind: 'file',
        target: 'src/app.txt',
      }),
      /No application is associated/i,
    );
    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'unsafe-url',
        projectId: 'project-a',
        kind: 'url',
        target: 'javascript:alert(1)',
      }),
      /apenas http:\/\/ ou https:\/\//i,
    );
  } finally {
    await f.cleanup();
  }
});

test('Electron adapter rejects unknown project for workspace-backed instance kinds', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.adapter.open({
        instanceId: 'unknown-project',
        projectId: 'missing-project',
        kind: 'file',
        target: 'src/app.txt',
      }),
      /Projeto não encontrado/i,
    );
  } finally {
    await f.cleanup();
  }
});
