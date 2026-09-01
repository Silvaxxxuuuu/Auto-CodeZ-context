import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectContextRuntime } from '../src/agent/project-context-runtime';
import type { ProjectRecord } from '../src/ai/types';

async function fixture(): Promise<{ root: string; project: ProjectRecord; context: ProjectContextRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-context-test-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'generic.ts'), 'export const generic = true;');
  await fs.writeFile(path.join(root, 'src', 'engine.ts'), 'export function engine() { return "workspace engine target"; }');
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=secret-value');

  const project: ProjectRecord = { id: 'context-project', name: 'Context Test', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const manager = {
    async list() { return [project]; },
    async scan() {
      return [
        { path: path.join(root, 'src'), relativePath: 'src', type: 'directory' as const },
        { path: path.join(root, 'src', 'generic.ts'), relativePath: 'src/generic.ts', type: 'file' as const },
        { path: path.join(root, 'src', 'engine.ts'), relativePath: 'src/engine.ts', type: 'file' as const },
        { path: path.join(root, '.env'), relativePath: '.env', type: 'file' as const },
      ];
    },
  };

  return { root, project, context: new ProjectContextRuntime(manager as never), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('selects files by content relevance when the filename is generic', async () => {
  const fixtureData = await fixture();
  try {
    const result = await fixtureData.context.build(fixtureData.project.id, 'workspace engine target');
    assert.match(result, /File: src\/engine\.ts/);
    assert.doesNotMatch(result, /API_KEY=secret-value/);
  } finally { await fixtureData.cleanup(); }
});

test('does not expose sensitive files even when the query names them', async () => {
  const fixtureData = await fixture();
  try {
    const result = await fixtureData.context.build(fixtureData.project.id, 'API_KEY secret-value .env');
    assert.doesNotMatch(result, /File: \.env/);
    assert.doesNotMatch(result, /API_KEY=secret-value/);
  } finally { await fixtureData.cleanup(); }
});
