import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { runWithExecutionWorkspaceContext } from '../src/agent/execution-workspace-context';
import { ShadowAwareGitRuntime } from '../src/agent/shadow-aware-git-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
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

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-aware-git-'));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'auto-codez-tests@example.invalid']);
  await git(root, ['config', 'user.name', 'Auto CodeZ Tests']);
  await fs.writeFile(path.join(root, 'a.txt'), 'base\n', 'utf8');
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', 'initial']);

  const projects = async (): Promise<ProjectRecord[]> => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }];
  const workspace = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(workspace);
  const runtime = new ShadowAwareGitRuntime(projects, shadows);
  const indexPath = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();

  return {
    root,
    workspace,
    shadows,
    runtime,
    indexPath,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('status e diff da execução usam a visão shadow enquanto chamadas externas continuam vendo a base', async () => {
  const fx = await fixture();
  try {
    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'shadow\n');

    const external = await fx.runtime.status('project-a');
    assert.equal(external.clean, true);

    const result = await runWithExecutionWorkspaceContext(
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      async () => ({
        status: await fx.runtime.status('project-a'),
        diff: await fx.runtime.diff('project-a'),
      }),
    );

    assert.equal(result.status.files.some((item) => item.path === 'a.txt' && item.worktree === 'M'), true);
    assert.match(result.diff, /shadow/);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'base\n');
  } finally {
    await fx.cleanup();
  }
});

test('branches e log continuam disponíveis porque o shadow não altera refs', async () => {
  const fx = await fixture();
  try {
    fx.shadows.begin('chat-a', 'run-a', 'project-a');

    const result = await runWithExecutionWorkspaceContext(
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      async () => ({
        branches: await fx.runtime.branches('project-a'),
        log: await fx.runtime.log('project-a', 5),
      }),
    );

    assert.equal(result.branches.some((branch) => branch.current), true);
    assert.equal(result.log[0]?.subject, 'initial');
  } finally {
    await fx.cleanup();
  }
});

test('qualquer mutação Git é bloqueada enquanto existe shadow ativo no projeto, mesmo fora do contexto do agente', async () => {
  const fx = await fixture();
  try {
    fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await fs.writeFile(path.join(fx.root, 'a.txt'), 'external-dirty\n', 'utf8');
    const indexBefore = await fs.readFile(fx.indexPath);

    await assert.rejects(
      () => fx.runtime.stageAll('project-a'),
      /Shadow Workspace ativo/i,
    );
    await assert.rejects(
      () => fx.runtime.createBranch('project-a', 'blocked-branch'),
      /Shadow Workspace ativo/i,
    );

    assert.deepEqual(await fs.readFile(fx.indexPath), indexBefore);
    assert.equal((await git(fx.root, ['branch', '--show-current'])).trim() === 'blocked-branch', false);
  } finally {
    await fx.cleanup();
  }
});

test('sem shadow ativo as mutações Git preservam o comportamento existente', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(path.join(fx.root, 'a.txt'), 'dirty\n', 'utf8');
    const staged = await fx.runtime.stageAll('project-a');
    const status = await fx.runtime.status('project-a');

    assert.equal(staged.operation, 'stage_all');
    assert.equal(status.files.some((item) => item.path === 'a.txt' && item.index === 'M'), true);
  } finally {
    await fx.cleanup();
  }
});

test('contexto Git de outro projeto falha fechado', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => runWithExecutionWorkspaceContext(
        { chatId: 'chat-a', runId: 'run-a', projectId: 'project-b' },
        () => fx.runtime.status('project-a'),
      ),
      /outro projeto/i,
    );
  } finally {
    await fx.cleanup();
  }
});
