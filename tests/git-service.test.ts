import assert from 'node:assert/strict';
import test from 'node:test';
import { GitService } from '../src/agent/git-service';
import type { GitBranch, GitCommitSummary, GitRuntime, GitStatus } from '../src/agent/git-runtime';

class FakeGitRuntime implements GitRuntime {
  async status(projectId: string): Promise<GitStatus> {
    return { branch: projectId, ahead: 1, behind: 2, clean: true, files: [] };
  }

  async branches(projectId: string): Promise<GitBranch[]> {
    return [{ name: projectId, current: true }];
  }

  async diff(projectId: string): Promise<string> {
    return `diff:${projectId}`;
  }

  async log(projectId: string, limit?: number): Promise<GitCommitSummary[]> {
    return [{ hash: projectId, shortHash: projectId.slice(0, 7), author: 'test', date: '2026-01-01T00:00:00Z', subject: `limit:${limit ?? 'default'}` }];
  }
}

test('GitService delegates read-only operations to GitRuntime', async () => {
  const service = new GitService(new FakeGitRuntime());
  assert.deepEqual(await service.status('project-1'), { branch: 'project-1', ahead: 1, behind: 2, clean: true, files: [] });
  assert.deepEqual(await service.branches('project-1'), [{ name: 'project-1', current: true }]);
  assert.equal(await service.diff('project-1'), 'diff:project-1');
  assert.deepEqual(await service.log('project-1', 10), [{ hash: 'project-1', shortHash: 'project-', author: 'test', date: '2026-01-01T00:00:00Z', subject: 'limit:10' }]);
});
