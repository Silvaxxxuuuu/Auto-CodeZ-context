import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitOperationSummary, ProjectRecord } from '../ai/types';
import { WorkspacePathPolicy } from './workspace-path-policy';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;

export interface GitStatus { branch: string; ahead: number; behind: number; clean: boolean; files: Array<{ path: string; index: string; worktree: string }>; }
export interface GitBranch { name: string; current: boolean; upstream?: string; }
export interface GitCommitSummary { hash: string; shortHash: string; author: string; date: string; subject: string; }

function requireSafeBranchName(name: string): string { const value = name.trim(); if (!value) throw new Error('Nome da branch é obrigatório.'); if (value.length > 200) throw new Error('Nome da branch é longo demais.'); if (/\s/.test(value) || value.startsWith('-') || value.includes('..') || value.includes('\\') || value.includes('~') || value.includes('^') || value.includes(':') || value.includes('?') || value.includes('*') || value.includes('[')) throw new Error('Nome da branch contém caracteres inválidos.'); return value; }
function requireCommitMessage(message: string): string { const value = message.trim(); if (!value) throw new Error('Mensagem do commit é obrigatória.'); if (value.length > 500) throw new Error('Mensagem do commit é longa demais.'); return value; }
function requireSafePath(pathValue: string): string { const value = pathValue.trim(); if (!value) throw new Error('Arquivo é obrigatório.'); if (value.includes('\0') || value.startsWith('-')) throw new Error('Caminho de arquivo inválido.'); return value; }
function expandStatusPath(value: string): string[] { const separator = ' -> '; const index = value.indexOf(separator); return index > 0 ? [value.slice(0, index), value.slice(index + separator.length)] : [value]; }

export class GitRuntime {
  constructor(private readonly listProjects: () => Promise<ProjectRecord[]>, private readonly pathPolicy = new WorkspacePathPolicy()) {}
  private async projectRoot(projectId: string): Promise<string> {
    const project = (await this.listProjects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project.rootPath;
  }
  private async repoRoot(projectId: string): Promise<string> {
    const cwd = await this.projectRoot(projectId);
    try {
      const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, maxBuffer: 64 * 1024 });
      const root = result.stdout.trim();
      if (!root) throw new Error('O Git não retornou a raiz do repositório.');
      return root;
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
      if (/not a git repository/i.test(stderr) || /not a git repository/i.test(error instanceof Error ? error.message : '')) {
        throw new Error(`A pasta do projeto não é um repositório Git: ${cwd}`);
      }
      throw new Error(stderr || (error instanceof Error ? error.message : 'Não foi possível localizar a raiz do repositório Git.'));
    }
  }
  private async git(projectId: string, args: string[]): Promise<string> {
    const cwd = await this.repoRoot(projectId);
    try {
      const result = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: MAX_OUTPUT });
      return result.stdout;
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
      throw new Error(stderr || (error instanceof Error ? error.message : 'Falha ao executar Git.'));
    }
  }
  private assertSafeStagePaths(paths: string[]): void {
    const evaluation = this.pathPolicy.evaluate('git_stage', paths);
    if (evaluation.decision !== 'deny') return;
    const reason = evaluation.reasons.length ? `: ${evaluation.reasons.join(' · ')}` : '';
    throw new Error(`Operação Git bloqueada pela política de segurança do workspace${reason}.`);
  }
  private async stagedPaths(projectId: string): Promise<string[]> {
    const output = await this.git(projectId, ['diff', '--cached', '--name-only', '--diff-filter=ACMRD']);
    return output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
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
      if (index === '?' && worktree === '?') return { path: line.slice(3).replace(/^"|"$/g, ''), index: ' ', worktree: '?' };
      return { path: line.slice(3).replace(/^"|"$/g, ''), index, worktree };
    });
    return { branch, ahead, behind, clean: files.length === 0, files };
  }
  async branches(projectId: string): Promise<GitBranch[]> { const output = await this.git(projectId, ['branch', '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)']); return output.split(/\r?\n/).filter(Boolean).map((line) => { const [marker, name, upstream] = line.split('\t'); return { name, current: marker === '*', ...(upstream ? { upstream } : {}) }; }); }
  async diff(projectId: string): Promise<string> { return this.git(projectId, ['diff', '--no-ext-diff', '--unified=3']); }
  async log(projectId: string, limit = 20): Promise<GitCommitSummary[]> { const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit))); const output = await this.git(projectId, ['log', `-${safeLimit}`, '--format=%H%x09%h%x09%an%x09%aI%x09%s']); return output.split(/\r?\n/).filter(Boolean).map((line) => { const [hash, shortHash, author, date, ...subject] = line.split('\t'); return { hash, shortHash, author, date, subject: subject.join('\t') }; }); }
  async createBranch(projectId: string, name: string): Promise<GitOperationSummary> { const branch = requireSafeBranchName(name); const output = await this.git(projectId, ['switch', '-c', branch]); return { operation: 'create_branch', output: output.trim(), branch }; }
  async checkout(projectId: string, name: string): Promise<GitOperationSummary> { const branch = requireSafeBranchName(name); const output = await this.git(projectId, ['switch', branch]); return { operation: 'checkout', output: output.trim(), branch }; }
  async stage(projectId: string, paths: string[]): Promise<GitOperationSummary> { if (!Array.isArray(paths) || paths.length === 0) throw new Error('Selecione ao menos um arquivo para adicionar ao commit.'); const safePaths = paths.map(requireSafePath); this.assertSafeStagePaths(safePaths); const output = await this.git(projectId, ['add', '--all', '--', ...safePaths]); const status = await this.status(projectId); return { operation: 'stage', output: output.trim(), branch: status.branch }; }
  async stageAll(projectId: string): Promise<GitOperationSummary> { const statusBefore = await this.status(projectId); const paths = statusBefore.files.flatMap((item) => expandStatusPath(item.path)); this.assertSafeStagePaths(paths); const output = await this.git(projectId, ['add', '--all']); const status = await this.status(projectId); return { operation: 'stage_all', output: output.trim(), branch: status.branch }; }
  async commit(projectId: string, message: string): Promise<GitOperationSummary> { const commitMessage = requireCommitMessage(message); this.assertSafeStagePaths(await this.stagedPaths(projectId)); const output = await this.git(projectId, ['commit', '-m', commitMessage]); const status = await this.status(projectId); return { operation: 'commit', output: output.trim(), branch: status.branch }; }
}
