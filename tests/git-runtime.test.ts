import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { GitRuntime } from '../src/agent/git-runtime';

async function makeRepository(): Promise<{ root: string; project: ProjectRecord }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-git-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@autocodez.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Auto CodeZ Test'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), '# Test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
  return {
    root,
    project: { id: 'project-1', name: 'Test', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() },
  };
}

test('GitRuntime returns clean status and current branch', async () => {
  const repository = await makeRepository();
  try {
    const runtime = new GitRuntime(async () => [repository.project]);
    const status = await runtime.status(repository.project.id);
    assert.equal(status.clean, true);
    assert.equal(status.files.length, 0);
    assert.ok(status.branch);
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime detects working tree changes and returns diff', async () => {
  const repository = await makeRepository();
  try {
    await fs.writeFile(path.join(repository.root, 'README.md'), '# Changed\n', 'utf8');
    const runtime = new GitRuntime(async () => [repository.project]);
    const status = await runtime.status(repository.project.id);
    assert.equal(status.clean, false);
    assert.equal(status.files[0]?.path, 'README.md');
    const diff = await runtime.diff(repository.project.id);
    assert.match(diff, /Changed/);
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime lists branches and commit history without mutating the repository', async () => {
  const repository = await makeRepository();
  try {
    const runtime = new GitRuntime(async () => [repository.project]);
    const branches = await runtime.branches(repository.project.id);
    const history = await runtime.log(repository.project.id, 10);
    assert.ok(branches.some((branch) => branch.current));
    assert.equal(history.length, 1);
    assert.equal(history[0]?.subject, 'initial');
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime rejects unknown projects', async () => {
  const runtime = new GitRuntime(async () => []);
  await assert.rejects(() => runtime.status('missing'), /Projeto não encontrado/);
});
