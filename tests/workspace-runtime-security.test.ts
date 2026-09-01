import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import type { ProjectRecord } from '../src/ai/types';

async function fixture(): Promise<{ root: string; runtime: WorkspaceRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-workspace-security-'));
  const project: ProjectRecord = {
    id: 'workspace-security-project',
    name: 'Workspace Security Project',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    root,
    runtime: new WorkspaceRuntime(async () => [project]),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('file mutation methods reject directories', async () => {
  const { root, runtime, cleanup } = await fixture();
  try {
    await fs.mkdir(path.join(root, 'directory'));

    await assert.rejects(
      runtime.readFile('workspace-security-project', 'directory'),
      /arquivo regular/i,
    );
    await assert.rejects(
      runtime.writeFile('workspace-security-project', 'directory', 'content'),
      /arquivo regular/i,
    );
    await assert.rejects(
      runtime.deleteFile('workspace-security-project', 'directory'),
      /arquivo regular/i,
    );
    await assert.rejects(
      runtime.renameFile('workspace-security-project', 'directory', 'renamed'),
      /arquivo regular/i,
    );
  } finally {
    await cleanup();
  }
});

test('workspace paths cannot escape through traversal', async () => {
  const { runtime, cleanup } = await fixture();
  try {
    await assert.rejects(
      runtime.readFile('workspace-security-project', '../outside.txt'),
      /fora do workspace/i,
    );
  } finally {
    await cleanup();
  }
});
