import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandRuntime } from '../src/agent/command-runtime';
import type { ProjectRecord } from '../src/ai/types';

test('command runtime preserves UTF-8 output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-unicode-'));
  try {
    const project: ProjectRecord = { id: 'project-test', name: 'Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
    const runtime = new CommandRuntime(async () => [project]);
    const result = await runtime.run('project-test', `node -e "process.stdout.write('ação, eficiência, decisões')"`);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ação, eficiência, decisões');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
