import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitOperationSummary, ProjectRecord } from '../ai/types';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: Array<{
    path: string;
    index: string;
    worktree: string;
  }>;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

function requireSafeBranchName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error('Nome da branch é obrigatório.');
  if (value.length > 200) throw new Error('Nome da branch é longo demais.');
  if (/\s/.test(value) || value.startsWith('-') || value.includes('..') || value.includes('\\') || value.includes('~') || value.includes('^') || value.includes(':') || value.includes('?') || value.includes('*') || value.includes('[')) {
    throw new Error('Nome da branch contém caracteres inválidos.');
  }
  return value;
}

function requireCommitMessage(message: string): string {
  const value = message.trim();
  if (!value) throw new Error('Mensagem do commit é obrigatória.');
  if (value.length > 500) throw new Error('Mensagem do commit é longa demais.');
  return value;
}

function requireSafePath(pathValue: string): string {
  const value = pathValue.trim();
  if (!value) throw new Error('Arquivo é obrigatório.');
  if (value.includes('\0') || value.startsWith('-')) throw new Error('Caminho de arquivo inválido.');
  return value;
}

export class GitRuntime {
  constructor(private readonly listProjects: () => Promise<ProjectRecord[]>) {}

  private async root(projectId: string): Promise<string> {
    const project = (await this.listProjects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project.rootPath;
  }

  private async git(projectId: string, args: string[]): Promise<string> {
    const cwd = await this.root(projectId);
    try {
      const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: MAX_OUTPUT });
      return result.stdout;
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
      const message = stderr || (error instanceof Error ? error.message : 'Falha ao executar Git.');
      throw new Error(message);
    }
  }

  async status(projectId: string): Promise<GitStatus> {
    const output = await this.git(projectId, ['status', '--porcelain=v1', '-b']);
    const lines = output.split(/\r?\n/).filter(Boolean);
    const header = lines.shift() || '## HEAD';
    const match = header.match(/^## (.+?)(?:\.\.\.(.+?))?(?: \[(.+)\])?$/);
    const branch = match?.[1] || 'HEAD';
    const tracking = match?.[3] || '';
    const ahead = Number(tracking.match(/ahead (\d+)/)?.[1] || 0);
    const behind = Number(tracking.match(/behind (\d+)/)?.[1] || 0);
    const files = lines.map((line) => {
      const index = line[0] || ' ';
      const worktree = line[1] || ' ';
      const path = line.slice(3).replace(/^"|"$/g, '');
      return { path, index, worktree };
    });
    return { branch, ahead, behind, clean: files.length === 0, files };
  }

  async branches(projectId: string): Promise<GitBranch[]> {
    const output = await this.git(projectId, ['branch', '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)']);
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [marker, name, upstream] = line.split('\t');
      return { name, current: marker === '*', ...(upstream ? { upstream } : {}) };
    });
  }

  async diff(projectId: string): Promise<string> {
    return this.git(projectId, ['diff', '--no-ext-diff', '--unified=3']);
  }

  async log(projectId: string, limit = 20): Promise<GitCommitSummary[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const output = await this.git(projectId, ['log', `-${safeLimit}`, '--format=%H%x09%h%x09%an%x09%aI%x09%s']);
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, shortHash, author, date, ...subject] = line.split('\t');
      return { hash, shortHash, author, date, subject: subject.join('\t') };
    });
  }

  async createBranch(projectId: string, name: string): Promise<GitOperationSummary> {
    const branch = requireSafeBranchName(name);
    const output = await this.git(projectId, ['switch', '-c', '--', branch]);
    return { operation: 'create_branch', output: output.trim(), branch };
  }

  async checkout(projectId: string, name: string): Promise<GitOperationSummary> {
    const branch = requireSafeBranchName(name);
    const output = await this.git(projectId, ['switch', '--', branch]);
    return { operation: 'checkout', output: output.trim(), branch };
  }

  async stage(projectId: string, paths: string[]): Promise<GitOperationSummary> {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('Selecione ao menos um arquivo para adicionar ao commit.');
    const safePaths = paths.map(requireSafePath);
    const output = await this.git(projectId, ['add', '--', ...safePaths]);
    const status = await this.status(projectId);
    return { operation: 'stage', output: output.trim(), branch: status.branch };
  }

  async stageAll(projectId: string): Promise<GitOperationSummary> {
    const output = await this.git(projectId, ['add', '--all']);
    const status = await this.status(projectId);
    return { operation: 'stage_all', output: output.trim(), branch: status.branch };
  }

  async commit(projectId: string, message: string): Promise<GitOperationSummary> {
    const commitMessage = requireCommitMessage(message);
    const output = await this.git(projectId, ['commit', '-m', commitMessage]);
    const status = await this.status(projectId);
    return { operation: 'commit', output: output.trim(), branch: status.branch };
  }
}