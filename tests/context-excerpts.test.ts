import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTaskFocusedExcerpt } from '../src/project/context-excerpts';
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

test('task focused excerpt preserves small files exactly', () => {
  const content = 'export const alpha = 1;\nexport const beta = 2;';
  assert.equal(buildTaskFocusedExcerpt(content, 'alpha beta'), content);
});

test('task focused excerpt keeps query windows from large files and marks omissions', () => {
  const lines = Array.from({ length: 1800 }, (_, index) => `const filler${index} = "ordinary fixture";`);
  lines[1650] = 'export const orbitalSynchronizationSentinel = "target";';
  const content = lines.join('\n');
  const excerpt = buildTaskFocusedExcerpt(content, 'orbital synchronization sentinel', 24 * 1024);

  assert.match(excerpt, /orbitalSynchronizationSentinel/);
  assert.match(excerpt, /lines omitted/);
  assert.doesNotMatch(excerpt, /filler900/);
  assert.ok(Buffer.byteLength(excerpt, 'utf8') <= 24 * 1024);
});

test('task focused excerpt falls back to a bounded prefix when the query has no match', () => {
  const content = Array.from({ length: 1800 }, (_, index) => `line-${index}-ordinary`).join('\n');
  const excerpt = buildTaskFocusedExcerpt(content, 'nonexistent target', 48 * 1024);

  assert.match(excerpt, /^line-0-ordinary/);
  assert.doesNotMatch(excerpt, /line-1799-ordinary/);
  assert.ok(Buffer.byteLength(excerpt, 'utf8') <= 32 * 1024);
});

test('project context uses focused excerpts for selected large files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-context-excerpt-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const lines = Array.from({ length: 2200 }, (_, index) => `export const filler${index} = "ordinary fixture";`);
    lines[2050] = 'export const orbitalSynchronizationSentinel = "target";';
    await fs.writeFile(path.join(root, 'src', 'large.ts'), lines.join('\n'), 'utf8');
    await fs.writeFile(path.join(root, 'src', 'other.ts'), 'export const other = true;', 'utf8');

    const manager = new ProjectManager(new MemoryStorage());
    const project = await manager.create('Excerpt Project', root);
    const context = await manager.buildContext(project.id, undefined, 'large orbital synchronization sentinel');

    assert.match(context, /--- src[\\/]large\.ts ---/);
    assert.match(context, /orbitalSynchronizationSentinel/);
    assert.match(context, /lines omitted/);
    assert.doesNotMatch(context, /filler1000/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
