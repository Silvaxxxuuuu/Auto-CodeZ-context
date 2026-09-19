import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { ProjectManager } from '../src/project/project-manager';
import { WorkspaceLexicalIndexRuntime } from '../src/project/workspace-lexical-index';

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

async function lexicalFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-lexical-index-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'private'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'generic.ts'), 'export const value = "workspace engine target";', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'other.ts'), 'export const other = "ordinary fixture";', 'utf8');
  await fs.writeFile(path.join(root, 'private', 'hidden.ts'), 'export const hidden = "private orbital signal";', 'utf8');
  await fs.writeFile(path.join(root, '.env'), 'SECRET_PHRASE=workspace engine target', 'utf8');
  const project: ProjectRecord = {
    id: 'lexical-project',
    name: 'Lexical Project',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  return { root, project, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('lexical index ranks file content without persisting source text or sensitive files', async () => {
  const data = await lexicalFixture();
  const storage = new MemoryStorage();
  try {
    const runtime = new WorkspaceLexicalIndexRuntime(storage, () => 100);
    await runtime.init();
    const status = await runtime.refresh(data.project, ['src/generic.ts', 'src/other.ts', 'private/hidden.ts', '.env']);
    const ranked = await runtime.rank(data.project.id, 'workspace engine target');
    const persisted = JSON.stringify(storage.get('workspace-lexical-index-v1.json'));

    assert.equal(ranked[0]?.relativePath.replaceAll('\\', '/'), 'src/generic.ts');
    assert.equal(ranked[0]?.matchedTokens, 3);
    assert.equal(status.indexedFiles, 3);
    assert.equal(status.signatureFiles, 3);
    assert.doesNotMatch(persisted, /workspace engine target/i);
    assert.doesNotMatch(persisted, /SECRET_PHRASE/);
    assert.doesNotMatch(persisted, /\.env"/);
  } finally {
    await data.cleanup();
  }
});

test('lexical index reuses persisted signatures after reconstruction', async () => {
  const data = await lexicalFixture();
  const storage = new MemoryStorage();
  try {
    const first = new WorkspaceLexicalIndexRuntime(storage, () => 100);
    await first.init();
    const initial = await first.refresh(data.project, ['src/generic.ts', 'src/other.ts']);
    assert.equal(initial.updatedFiles, 2);

    const restored = new WorkspaceLexicalIndexRuntime(storage, () => 200);
    await restored.init();
    const reused = await restored.refresh(data.project, ['src/generic.ts', 'src/other.ts']);
    const ranked = await restored.rank(data.project.id, 'workspace engine target');

    assert.equal(reused.updatedFiles, 0);
    assert.equal(reused.reusedFiles, 2);
    assert.equal(ranked[0]?.relativePath.replaceAll('\\', '/'), 'src/generic.ts');
  } finally {
    await data.cleanup();
  }
});

test('lexical refresh removes out-of-scope signatures before persistence or matching', async () => {
  const data = await lexicalFixture();
  const storage = new MemoryStorage();
  try {
    const runtime = new WorkspaceLexicalIndexRuntime(storage, () => 100);
    await runtime.init();
    await runtime.refresh(data.project, ['src/generic.ts', 'private/hidden.ts']);
    assert.match(JSON.stringify(storage.get('workspace-lexical-index-v1.json')), /private[\\/]hidden\.ts/);

    const includeSource = async (relativePath: string) => relativePath.replaceAll('\\', '/').startsWith('src/');
    const scopedStatus = await runtime.refresh(
      data.project,
      ['src/generic.ts', 'private/hidden.ts'],
      includeSource,
    );
    const persisted = JSON.stringify(storage.get('workspace-lexical-index-v1.json'));
    const ranked = await runtime.rank(data.project.id, 'private orbital signal', includeSource);

    assert.equal(scopedStatus.indexedFiles, 1);
    assert.equal(scopedStatus.removedFiles, 1);
    assert.doesNotMatch(persisted, /private[\\/]hidden\.ts/);
    assert.deepEqual(ranked, []);
  } finally {
    await data.cleanup();
  }
});

test('project context fusion retrieves a text-relevant file beyond structural candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-lexical-fusion-'));
  const storage = new MemoryStorage();
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    for (let index = 0; index < 70; index += 1) {
      const name = `file-${String(index).padStart(2, '0')}.ts`;
      await fs.writeFile(path.join(root, 'src', name), `export const value${index} = "ordinary fixture";`, 'utf8');
    }
    await fs.writeFile(
      path.join(root, 'src', 'zz-last.ts'),
      'export const payload = "orbital synchronization sentinel";',
      'utf8',
    );

    const manager = new ProjectManager(storage);
    const project = await manager.create('Fusion Project', root);
    const context = await manager.buildContext(project.id, undefined, 'orbital synchronization sentinel');

    assert.match(context, /--- src[\\/]zz-last\.ts ---/);
    assert.match(context, /orbital synchronization sentinel/);
    assert.match(context, /lexical signatures/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
