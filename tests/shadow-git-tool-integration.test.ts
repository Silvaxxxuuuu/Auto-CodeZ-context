import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';
import { ShadowAwareGitRuntime } from '../src/agent/shadow-aware-git-runtime';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { ShadowAwareWorkspaceRuntime } from '../src/agent/shadow-aware-workspace-runtime';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-git-tool-'));
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
  const base = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(base);
  const workspace = new ShadowAwareWorkspaceRuntime(base, shadows);
  const gitRuntime = new ShadowAwareGitRuntime(projects, shadows);
  const tools = new ShadowAwareToolRuntime(workspace);
  tools.configureShadowWorkspace(shadows);
  tools.configureGitRuntime(gitRuntime);
  const indexPath = (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();

  return {
    root,
    base,
    shadows,
    tools,
    indexPath,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('tools Git somente leitura enxergam o shadow e mutações continuam bloqueadas sem tocar no repositório real', async () => {
  const fx = await fixture();
  try {
    const indexBefore = await fs.readFile(fx.indexPath);
    const headBefore = (await git(fx.root, ['rev-parse', 'HEAD'])).trim();

    const write = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('write-shadow', 'write_file', { path: 'a.txt', content: 'shadow-value\n' }),
      'run-a',
    );
    assert.equal(write.ok, true);

    const statusResult = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('git-status-shadow', 'git_status', {}),
      'run-a',
    );
    const diffResult = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('git-diff-shadow', 'git_diff', {}),
      'run-a',
    );
    const logResult = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('git-log-shadow', 'git_log', { limit: 5 }),
      'run-a',
    );
    const branchesResult = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('git-branches-shadow', 'git_branches', {}),
      'run-a',
    );
    const mutationResult = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('git-stage-shadow', 'git_stage_all', {}),
      'run-a',
    );

    assert.equal(statusResult.ok, true);
    assert.equal(diffResult.ok, true);
    assert.equal(logResult.ok, true);
    assert.equal(branchesResult.ok, true);
    assert.equal(mutationResult.ok, false);

    const status = JSON.parse(statusResult.output ?? '{}') as {
      files?: Array<{ path: string; worktree: string }>;
    };
    const log = JSON.parse(logResult.output ?? '[]') as Array<{ subject?: string }>;
    const branches = JSON.parse(branchesResult.output ?? '[]') as Array<{ current?: boolean }>;

    assert.equal(status.files?.some((item) => item.path === 'a.txt' && item.worktree === 'M'), true);
    assert.match(diffResult.output ?? '', /shadow-value/);
    assert.equal(log[0]?.subject, 'initial');
    assert.equal(branches.some((branch) => branch.current), true);
    assert.match(mutationResult.error ?? '', /Git mutável bloqueada/i);

    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'base\n');
    assert.deepEqual(await fs.readFile(fx.indexPath), indexBefore);
    assert.equal((await git(fx.root, ['rev-parse', 'HEAD'])).trim(), headBefore);
    assert.equal(fx.shadows.get('chat-a', 'run-a')?.changes[0].after, 'shadow-value\n');
  } finally {
    await fx.cleanup();
  }
});
