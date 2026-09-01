import type { GitBranch, GitCommitSummary, GitRuntime, GitStatus } from './git-runtime';
import type { GitOperationSummary } from '../ai/types';

export class GitService {
  constructor(private readonly runtime: GitRuntime) {}
  status(projectId: string): Promise<GitStatus> { return this.runtime.status(projectId); }
  branches(projectId: string): Promise<GitBranch[]> { return this.runtime.branches(projectId); }
  diff(projectId: string): Promise<string> { return this.runtime.diff(projectId); }
  log(projectId: string, limit?: number): Promise<GitCommitSummary[]> { return this.runtime.log(projectId, limit); }
  createBranch(projectId: string, name: string): Promise<GitOperationSummary> { return this.runtime.createBranch(projectId, name); }
  checkout(projectId: string, name: string): Promise<GitOperationSummary> { return this.runtime.checkout(projectId, name); }
  stage(projectId: string, paths: string[]): Promise<GitOperationSummary> { return this.runtime.stage(projectId, paths); }
  stageAll(projectId: string): Promise<GitOperationSummary> { return this.runtime.stageAll(projectId); }
  commit(projectId: string, message: string): Promise<GitOperationSummary> { return this.runtime.commit(projectId, message); }
}
