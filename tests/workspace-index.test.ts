import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectManager } from '../src/project/project-manager';
import { WorkspaceIndexRuntime } from '../src/project/workspace-index';

type Stored = Record<string, unknown>;

type StoredIndex = {
  projects?: Array<{
    files?: Array<{
      relativePath?: string;
      imports?: string[];
    }>;
  }>;
};

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

function storedIndex(storage: MemoryStorage): StoredIndex | undefined {
  return storage.get('workspace-index-v2.json') as StoredIndex | undefined;
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
    assert.equal(status?.importCount, 0);
  } finally {
    await data.cleanup();
  }
});

test('workspace index promotes direct dependencies and dependents of relevant files', async () => {
  const data = await fixture();
  try {
    await fs.writeFile(
      path.join(data.root, 'src', 'auth.ts'),
      'import { credentialCache } from "./credential-cache"; export class TokenRefreshService { refreshToken() { return credentialCache.read(); } }',
      'utf8',
    );
    await fs.writeFile(
      path.join(data.root, 'src', 'credential-cache.ts'),
      'export const credentialCache = { read() { return "cached"; } };',
      'utf8',
    );
    await fs.writeFile(
      path.join(data.root, 'src', 'bootstrap.ts'),
      'import { TokenRefreshService } from "./auth"; export function startApplication() { return new TokenRefreshService(); }',
      'utf8',
    );

    const context = normalized(await data.manager.buildContext(data.project.id, undefined, 'repair TokenRefreshService behavior'));
    const authPosition = context.indexOf('--- src/auth.ts ---');
    const dependencyPosition = context.indexOf('--- src/credential-cache.ts ---');
    const dependentPosition = context.indexOf('--- src/bootstrap.ts ---');
    const rendererPosition = context.indexOf('--- src/renderer.ts ---');

    assert.ok(authPosition >= 0);
    assert.ok(dependencyPosition >= 0);
    assert.ok(dependentPosition >= 0);
    assert.ok(rendererPosition >= 0);
    assert.ok(authPosition < dependencyPosition);
    assert.ok(dependencyPosition < rendererPosition);
    assert.ok(dependentPosition < rendererPosition);

    const index = storedIndex(data.storage);
    const indexedFiles = index?.projects?.[0]?.files ?? [];
    const auth = indexedFiles.find((file) => normalized(file.relativePath || '') === 'src/auth.ts');
    const bootstrap = indexedFiles.find((file) => normalized(file.relativePath || '') === 'src/bootstrap.ts');
    assert.deepEqual(auth?.imports, ['./credential-cache']);
    assert.deepEqual(bootstrap?.imports, ['./auth']);
    assert.equal(data.manager.getWorkspaceIndexStatus(data.project.id)?.importCount, 2);
  } finally {
    await data.cleanup();
  }
});

test('workspace index resolves TypeScript sources imported with runtime JavaScript extensions', async () => {
  const data = await fixture();
  try {
    await fs.writeFile(
      path.join(data.root, 'src', 'auth.ts'),
      'import { internalState } from "./internal-state.js"; export class TokenRefreshService { refreshToken() { return internalState; } }',
      'utf8',
    );
    await fs.writeFile(path.join(data.root, 'src', 'internal-state.ts'), 'export const internalState = "stable";', 'utf8');

    const context = normalized(await data.manager.buildContext(data.project.id, undefined, 'TokenRefreshService'));
    const dependencyPosition = context.indexOf('--- src/internal-state.ts ---');
    const rendererPosition = context.indexOf('--- src/renderer.ts ---');
    assert.ok(dependencyPosition >= 0);
    assert.ok(rendererPosition >= 0);
    assert.ok(dependencyPosition < rendererPosition);
  } finally {
    await data.cleanup();
  }
});

test('workspace index extracts import, re-export, dynamic import and require references', async () => {
  const data = await fixture();
  try {
    await fs.writeFile(
      path.join(data.root, 'src', 'auth.ts'),
      [
        'import { one } from "./one";',
        'export { two } from "./two";',
        'const three = require("./three");',
        'export async function loadFour() { return import("./four"); }',
        'export const combined = [one, three];',
      ].join('\n'),
      'utf8',
    );
    await data.manager.buildContext(data.project.id, undefined, 'combined');

    const index = storedIndex(data.storage);
    const auth = index?.projects?.[0]?.files?.find((file) => normalized(file.relativePath || '') === 'src/auth.ts');
    assert.deepEqual(auth?.imports, ['./one', './two', './three', './four']);
  } finally {
    await data.cleanup();
  }
});

test('workspace index reuses persisted fingerprints, symbols and imports after manager reconstruction', async () => {
  const data = await fixture();
  try {
    await fs.writeFile(path.join(data.root, 'src', 'auth.ts'), 'import "./renderer"; export class TokenRefreshService { refreshToken() { return "fresh"; } }', 'utf8');
    await data.manager.buildContext(data.project.id, undefined, 'token refresh');
    const firstStatus = data.manager.getWorkspaceIndexStatus(data.project.id);
    assert.equal(firstStatus?.updatedFiles, 3);
    assert.equal(firstStatus?.importCount, 1);

    const restored = new ProjectManager(data.storage);
    await restored.init();
    await restored.buildContext(data.project.id, undefined, 'token refresh');
    const restoredStatus = restored.getWorkspaceIndexStatus(data.project.id);
    assert.equal(restoredStatus?.updatedFiles, 0);
    assert.equal(restoredStatus?.reusedFiles, 3);
    assert.ok((restoredStatus?.symbolCount ?? 0) >= 3);
    assert.equal(restoredStatus?.importCount, 1);
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
    const indexedPaths = storedIndex(data.storage)?.projects?.flatMap((project) => project.files?.map((file) => normalized(file.relativePath || '')) || []) || [];
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
    const stored = storedIndex(storage);

    assert.equal(status.indexedFiles, 0);
    assert.deepEqual(stored?.projects?.[0]?.files ?? [], []);
  } finally {
    await data.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});
