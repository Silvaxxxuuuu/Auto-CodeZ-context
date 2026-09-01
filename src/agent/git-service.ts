import type { GitBranch, GitCommitSummary, GitOperationResult, GitRuntime, GitStatus } from './git-runtime';

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

  createBranch(projectId: string, name: string): Promise<GitOperationResult> {
    return this.runtime.createBranch(projectId, name);
  }

  checkout(projectId: string, name: string): Promise<GitOperationResult> {
    return this.runtime.checkout(projectId, name);
  }

  commit(projectId: string, message: string): Promise<GitOperationResult> {
    return this.runtime.commit(projectId, message);
  }
}
