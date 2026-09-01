import type { GitBranch, GitCommitSummary, GitRuntime, GitStatus } from './git-runtime';

export class GitService {
  constructor(private readonly runtime: GitRuntime) {}

  status(projectId: string): Promise<GitStatus> {
    return this.runtime.status(projectId);
  }

  branches(projectId: string): Promise<GitBranch[]> {
    return this.runtime.branches(projectId);
  }

  diff(projectId: string): Promise<string> {
    return this.runtime.diff(projectId);
  }

  log(projectId: string, limit?: number): Promise<GitCommitSummary[]> {
    return this.runtime.log(projectId, limit);
  }
}
