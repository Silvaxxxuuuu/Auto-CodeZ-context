import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ShadowGitReadRuntime } from '../src/agent/shadow-git-read-runtime';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.stdout;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function initRepository(root: string): Promise<void> {
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'auto-codez-tests@example.invalid']);
  await git(root, ['config', 'user.name', 'Auto CodeZ Tests']);
}

async function fixture(projectRelative = '') {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-git-test-'));
  await initRepository(repoRoot);
  const projectRoot = projectRelative ? path.join(repoRoot, projectRelative) : repoRoot;
  await fs.mkdir(projectRoot, { recursive: true });
  await write(projectRoot, 'a.txt', 'base-a\n');
  await write(projectRoot, 'b.txt', 'base-b\n');
  await write(repoRoot, '.gitignore', 'node_modules/\n');
  await git(repoRoot, ['add', '--all']);
  await git(repoRoot, ['commit', '-m', 'initial']);

  const projects = async (): Promise<ProjectRecord[]> => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: projectRoot,
    createdAt: 1,
    updatedAt: 1,
  }];
  const workspace = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(workspace);
  const runtime = new ShadowGitReadRuntime(projects, shadows);
  const indexPath = (await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();

  return {
    repoRoot,
    projectRoot,
    workspace,
    shadows,
    runtime,
    indexPath,
    cleanup: async () => fs.rm(repoRoot, { recursive: true, force: true }),
  };
}

test('status e diff enxergam base real mais overlay sem tocar no index ou HEAD reais', async () => {
  const fx = await fixture();
  try {
    await write(fx.repoRoot, 'node_modules/ignored/index.js', 'ignored');
    await write(fx.projectRoot, 'b.txt', 'real-dirty\n');
    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'shadow-a\n');

    const indexBefore = await fs.readFile(fx.indexPath);
    const headBefore = (await git(fx.repoRoot, ['rev-parse', 'HEAD'])).trim();

    const status = await fx.runtime.status('chat-a', 'run-a', 'project-a');
    const diff = await fx.runtime.diff('chat-a', 'run-a', 'project-a');

    const a = status.files.find((item) => item.path === 'a.txt');
    const b = status.files.find((item) => item.path === 'b.txt');
    assert.equal(a?.worktree, 'M');
    assert.equal(b?.worktree, 'M');
    assert.equal(status.files.some((item) => item.path.includes('node_modules')), false);
    assert.match(diff, /shadow-a/);
    assert.match(diff, /real-dirty/);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'base-a\n');

    assert.deepEqual(await fs.readFile(fx.indexPath), indexBefore);
    assert.equal((await git(fx.repoRoot, ['rev-parse', 'HEAD'])).trim(), headBefore);
  } finally {
    await fx.cleanup();
  }
});

test('projeto aninhado aplica alterações no caminho correto da raiz Git', async () => {
  const fx = await fixture('packages/app');
  try {
    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'nested-shadow\n');

    const status = await fx.runtime.status('chat-a', 'run-a', 'project-a');
    const diff = await fx.runtime.diff('chat-a', 'run-a', 'project-a');

    assert.equal(status.files.some((item) => item.path.replaceAll('\\', '/') === 'packages/app/a.txt'), true);
    assert.match(diff.replaceAll('\\', '/'), /packages\/app\/a\.txt/);
    assert.match(diff, /nested-shadow/);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'base-a\n');
  } finally {
    await fx.cleanup();
  }
});

test('diretório gerado rastreado permanece na visão isolada e participa do diff', async () => {
  const fx = await fixture();
  try {
    await write(fx.projectRoot, 'dist/tracked.txt', 'tracked-old\n');
    await git(fx.repoRoot, ['add', '-f', 'dist/tracked.txt']);
    await git(fx.repoRoot, ['commit', '-m', 'track generated fixture']);

    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'dist/tracked.txt', 'tracked-shadow\n');

    const status = await fx.runtime.status('chat-a', 'run-a', 'project-a');
    const diff = await fx.runtime.diff('chat-a', 'run-a', 'project-a');

    assert.equal(status.files.some((item) => item.path.replaceAll('\\', '/') === 'dist/tracked.txt'), true);
    assert.match(diff, /tracked-shadow/);
  } finally {
    await fx.cleanup();
  }
});

test('visão Git rejeita run inexistente e projeto divergente', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => fx.runtime.status('chat-a', 'missing', 'project-a'),
      /Shadow Workspace ativo não encontrado/i,
    );

    fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await assert.rejects(
      () => fx.runtime.diff('chat-a', 'run-a', 'project-b'),
      /outro projeto/i,
    );
  } finally {
    await fx.cleanup();
  }
});
