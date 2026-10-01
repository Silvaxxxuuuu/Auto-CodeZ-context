import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectManager } from '../src/project/project-manager';

type Stored = Record<string, unknown>;

class MemoryStorage {
  private readonly values: Stored = {};

  async read<T>(name: string, fallback: T): Promise<T> {
    return (name in this.values ? this.values[name] : fallback) as T;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values[name] = value;
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-project-context-security-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'private'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'allowed.ts'), 'export const allowedMarker = "ALLOWED_CONTENT";', 'utf8');
  await fs.writeFile(path.join(root, 'private', 'hidden.ts'), 'export const hiddenMarker = "HIDDEN_CONTENT";', 'utf8');
  await fs.writeFile(path.join(root, '.env'), 'AUTO_CODEZ_SECRET=SUPER_SECRET_VALUE', 'utf8');
  await fs.writeFile(path.join(root, '.env.example'), 'AUTO_CODEZ_SECRET=', 'utf8');
  const manager = new ProjectManager(new MemoryStorage());
  const project = await manager.create('Security Context', root);
  return { root, manager, project, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('buildContext never injects sensitive workspace paths automatically', async () => {
  const data = await fixture();
  try {
    const context = await data.manager.buildContext(data.project.id);
    assert.doesNotMatch(context, /SUPER_SECRET_VALUE/);
    assert.doesNotMatch(context, /--- \.env ---/);
    assert.match(context, /--- \.env\.example ---/);
  } finally {
    await data.cleanup();
  }
});

test('buildContext applies execution path filter before reading file content', async () => {
  const data = await fixture();
  try {
    const visited: string[] = [];
    const context = await data.manager.buildContext(data.project.id, async (relativePath) => {
      visited.push(relativePath.replaceAll('\\', '/'));
      return relativePath.replaceAll('\\', '/').startsWith('src/');
    });

    assert.match(context, /ALLOWED_CONTENT/);
    assert.doesNotMatch(context, /HIDDEN_CONTENT/);
    assert.doesNotMatch(context, /SUPER_SECRET_VALUE/);
    assert.ok(visited.includes('src/allowed.ts'));
    assert.ok(visited.includes('private/hidden.ts'));
    assert.equal(visited.includes('.env'), false);
  } finally {
    await data.cleanup();
  }
});
