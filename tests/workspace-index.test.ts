import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectManager } from '../src/project/project-manager';
import { WorkspaceIndexRuntime } from '../src/project/workspace-index';

type Stored = Record<string, unknown>;

class MemoryStorage {
  private readonly values: Stored = {};

  async read<T>(name: string, fallback: T): Promise<T> {
    return (name in this.values ? this.values[name] : fallback) as T;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values[name] = value;
  }

  get(name: string): unknown {
    return this.values[name];
  }
}

async function fixture(storage = new MemoryStorage()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-workspace-index-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export class TokenRefreshService { refreshToken() { return "fresh"; } }', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'renderer.ts'), 'export function renderSidebar() { return "sidebar"; }', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# Workspace fixture', 'utf8');
  const manager = new ProjectManager(storage);
  const project = await manager.create('Workspace Index', root);
  return { root, manager, project, storage, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function normalized(value: string): string {
  return value.replaceAll('\\', '/');
}

test('workspace index ranks TypeScript symbols against the current task', async () => {
  const data = await fixture();
  try {
    const context = normalized(await data.manager.buildContext(data.project.id, undefined, 'fix token refresh authentication flow'));
    const authPosition = context.indexOf('--- src/auth.ts ---');
    const rendererPosition = context.indexOf('--- src/renderer.ts ---');
    assert.ok(authPosition >= 0);
    assert.ok(rendererPosition >= 0);
    assert.ok(authPosition < rendererPosition);
    assert.match(context, /TokenRefreshService/);
    const status = data.manager.getWorkspaceIndexStatus(data.project.id);
    assert.ok(status);
    assert.equal(status?.indexedFiles, 3);
    assert.ok((status?.symbolCount ?? 0) >= 3);
  } finally {
    await data.cleanup();
  }
});

test('workspace index reuses persisted fingerprints and symbols after manager reconstruction', async () => {
  const data = await fixture();
  try {
    await data.manager.buildContext(data.project.id, undefined, 'token refresh');
    const firstStatus = data.manager.getWorkspaceIndexStatus(data.project.id);
    assert.equal(firstStatus?.updatedFiles, 3);

    const restored = new ProjectManager(data.storage);
    await restored.init();
    await restored.buildContext(data.project.id, undefined, 'token refresh');
    const restoredStatus = restored.getWorkspaceIndexStatus(data.project.id);
    assert.equal(restoredStatus?.updatedFiles, 0);
    assert.equal(restoredStatus?.reusedFiles, 3);
    assert.ok((restoredStatus?.symbolCount ?? 0) >= 3);
  } finally {
    await data.cleanup();
  }
});

test('workspace index refreshes changed files and removes deleted files', async () => {
  const data = await fixture();
  try {
    await data.manager.buildContext(data.project.id, undefined, 'token refresh');
    const authPath = path.join(data.root, 'src', 'auth.ts');
    await fs.writeFile(authPath, 'export class SessionRefreshService { renewSession() { return "renewed"; } }', 'utf8');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(authPath, future, future);
    await fs.rm(path.join(data.root, 'src', 'renderer.ts'));

    const context = normalized(await data.manager.buildContext(data.project.id, undefined, 'renew session'));
    const status = data.manager.getWorkspaceIndexStatus(data.project.id);
    assert.match(context, /SessionRefreshService/);
    assert.doesNotMatch(context, /renderSidebar/);
    assert.equal(status?.updatedFiles, 1);
    assert.equal(status?.removedFiles, 1);
    assert.equal(status?.indexedFiles, 2);
  } finally {
    await data.cleanup();
  }
});

test('workspace index never persists sensitive automatic-context paths', async () => {
  const data = await fixture();
  try {
    await fs.writeFile(path.join(data.root, '.env'), 'PRIVATE_TOKEN=DO_NOT_INDEX', 'utf8');
    await fs.writeFile(path.join(data.root, '.env.example'), 'PRIVATE_TOKEN=', 'utf8');
    const context = normalized(await data.manager.buildContext(data.project.id, undefined, 'environment configuration'));
    const stored = data.storage.get('workspace-index-v1.json') as { projects?: Array<{ files?: Array<{ relativePath?: string }> }> } | undefined;
    const indexedPaths = stored?.projects?.flatMap((project) => project.files?.map((file) => normalized(file.relativePath || '')) || []) || [];
    assert.equal(indexedPaths.includes('.env'), false);
    assert.equal(indexedPaths.includes('.env.example'), true);
    assert.doesNotMatch(context, /DO_NOT_INDEX/);
  } finally {
    await data.cleanup();
  }
});

test('workspace index refuses a linked path whose real target escapes the workspace', async () => {
  const data = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-workspace-index-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.ts'), 'export const EXTERNAL_SECRET = "never-index";', 'utf8');
    const linkedDirectory = path.join(data.root, 'linked-outside');
    await fs.symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    const storage = new MemoryStorage();
    const runtime = new WorkspaceIndexRuntime(storage);
    await runtime.init();
    const status = await runtime.refresh(data.project, [path.join('linked-outside', 'secret.ts')]);
    const stored = storage.get('workspace-index-v1.json') as { projects?: Array<{ files?: Array<{ relativePath?: string }> }> } | undefined;

    assert.equal(status.indexedFiles, 0);
    assert.deepEqual(stored?.projects?.[0]?.files ?? [], []);
  } finally {
    await data.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});
