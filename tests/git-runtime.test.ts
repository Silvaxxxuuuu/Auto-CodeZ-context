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

test('GitRuntime creates and checks out a branch', async () => {
  const repository = await makeRepository();
  try {
    const runtime = new GitRuntime(async () => [repository.project]);
    const created = await runtime.createBranch(repository.project.id, 'feature/test-branch');
    assert.equal(created.branch, 'feature/test-branch');
    assert.equal((await runtime.status(repository.project.id)).branch, 'feature/test-branch');
    const branches = await runtime.branches(repository.project.id);
    assert.ok(branches.some((branch) => branch.name === 'feature/test-branch' && branch.current));
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime stages selected files and commits them', async () => {
  const repository = await makeRepository();
  try {
    await fs.writeFile(path.join(repository.root, 'README.md'), '# Selected\n', 'utf8');
    await fs.writeFile(path.join(repository.root, 'SECOND.md'), '# Unstaged\n', 'utf8');
    const runtime = new GitRuntime(async () => [repository.project]);
    await runtime.stage(repository.project.id, ['README.md']);
    let status = await runtime.status(repository.project.id);
    assert.equal(status.files.find((file) => file.path === 'README.md')?.index, 'M');
    assert.equal(status.files.find((file) => file.path === 'SECOND.md')?.index, ' ');
    const result = await runtime.commit(repository.project.id, 'update selected file');
    assert.equal(result.branch, status.branch);
    status = await runtime.status(repository.project.id);
    assert.equal(status.files.find((file) => file.path === 'SECOND.md')?.worktree, 'M');
    const history = await runtime.log(repository.project.id, 2);
    assert.equal(history[0]?.subject, 'update selected file');
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime stages all changes and rejects unsafe branch and path input', async () => {
  const repository = await makeRepository();
  try {
    await fs.writeFile(path.join(repository.root, 'README.md'), '# All\n', 'utf8');
    await fs.writeFile(path.join(repository.root, 'SECOND.md'), '# All\n', 'utf8');
    const runtime = new GitRuntime(async () => [repository.project]);
    await runtime.stageAll(repository.project.id);
    const status = await runtime.status(repository.project.id);
    assert.equal(status.files.every((file) => file.index.trim()), true);
    await assert.rejects(() => runtime.stage(repository.project.id, []), /ao menos um arquivo/);
    await assert.rejects(() => runtime.stage(repository.project.id, ['-bad']), /Caminho de arquivo inválido/);
    await assert.rejects(() => runtime.createBranch(repository.project.id, 'bad name'), /caracteres inválidos/);
    await assert.rejects(() => runtime.createBranch(repository.project.id, '-bad'), /caracteres inválidos/);
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime commits staged changes and preserves the branch', async () => {
  const repository = await makeRepository();
  try {
    await fs.writeFile(path.join(repository.root, 'README.md'), '# Committed\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repository.root });
    const runtime = new GitRuntime(async () => [repository.project]);
    const result = await runtime.commit(repository.project.id, 'update README');
    assert.equal(result.branch, (await runtime.status(repository.project.id)).branch);
    const history = await runtime.log(repository.project.id, 2);
    assert.equal(history[0]?.subject, 'update README');
    await assert.rejects(() => runtime.commit(repository.project.id, '   '), /Mensagem do commit é obrigatória/);
  } finally {
    await fs.rm(repository.root, { recursive: true, force: true });
  }
});

test('GitRuntime rejects unknown projects', async () => {
  const runtime = new GitRuntime(async () => []);
  await assert.rejects(() => runtime.status('missing'), /Projeto não encontrado/);
});
