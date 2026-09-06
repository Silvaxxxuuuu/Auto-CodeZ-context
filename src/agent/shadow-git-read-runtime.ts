import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectRecord } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { compactShadowWorkspaceChanges } from '../shadow-workspace-publication';
import type { GitStatus } from './git-runtime';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PATH_LIST_OUTPUT = 32 * 1024 * 1024;
const generatedSegments = new Set(['node_modules', '.vite', '.test-dist', 'dist', 'build', 'out', 'coverage']);

type RepositoryContext = {
  projectRoot: string;
  repoRoot: string;
  gitDir: string;
  indexPath: string;
  projectPrefix: string;
  visibleGeneratedSegments: Set<string>;
};

type ShadowGitSandbox = {
  rootPath: string;
  indexPath: string;
  cleanup(): Promise<void>;
};

type MaterializedShadowGit = {
  context: RepositoryContext;
  sandbox: ShadowGitSandbox;
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string') throw new Error('Caminho inválido para a visão Git isolada.');
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
  const segments = normalized.split('/');
  if (
    !normalized
    || normalized === '.'
    || segments.includes('..')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || path.win32.parse(normalized).root !== ''
  ) {
    throw new Error('Caminho inválido para a visão Git isolada.');
  }
  return normalized;
}

function prefixedPath(prefix: string, requestedPath: string): string {
  const relative = normalizeRelativePath(requestedPath);
  return prefix ? normalizeRelativePath(`${prefix}/${relative}`) : relative;
}

function parseNullSeparated(output: string): string[] {
  return output.split('\0').filter(Boolean).map((item) => item.replaceAll('\\', '/'));
}

function visibleGeneratedSegments(paths: string[]): Set<string> {
  const visible = new Set<string>();
  for (const requestedPath of paths) {
    for (const segment of requestedPath.split('/')) {
      if (generatedSegments.has(segment)) visible.add(segment);
    }
  }
  return visible;
}

function parseStatus(output: string): GitStatus {
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
    if (index === '?' && worktree === '?') {
      return { path: line.slice(3).replace(/^"|"$/g, ''), index: ' ', worktree: '?' };
    }
    return { path: line.slice(3).replace(/^"|"$/g, ''), index, worktree };
  });
  return { branch, ahead, behind, clean: files.length === 0, files };
}

function gitEnvironment(indexPath?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
  };
}

async function runGit(cwd: string, args: string[], maxBuffer = MAX_OUTPUT, indexPath?: string): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer,
      env: gitEnvironment(indexPath),
    });
    return result.stdout;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : '';
    throw new Error(stderr || (error instanceof Error ? error.message : 'Falha ao executar Git na visão isolada.'));
  }
}

export class ShadowGitReadRuntime {
  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly shadows: ExecutionShadowWorkspaceRuntime,
  ) {}

  async status(chatId: string, runId: string, projectId: string): Promise<GitStatus> {
    const { context, sandbox } = await this.materialize(chatId, runId, projectId);
    try {
      const output = await this.gitInSandbox(context, sandbox, [
        'status',
        '--porcelain=v1',
        '-b',
        '--ignore-submodules=all',
      ]);
      return parseStatus(output);
    } finally {
      await sandbox.cleanup();
    }
  }

  async diff(chatId: string, runId: string, projectId: string): Promise<string> {
    const { context, sandbox } = await this.materialize(chatId, runId, projectId);
    try {
      return await this.gitInSandbox(context, sandbox, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=all',
        '--unified=3',
      ]);
    } finally {
      await sandbox.cleanup();
    }
  }

  private async projectRoot(projectId: string): Promise<string> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado para a visão Git isolada.');
    return fs.realpath(path.resolve(project.rootPath));
  }

  private async repositoryContext(projectId: string): Promise<RepositoryContext> {
    const projectRoot = await this.projectRoot(projectId);
    const repoRootRaw = (await runGit(projectRoot, ['rev-parse', '--show-toplevel'], 64 * 1024)).trim();
    if (!repoRootRaw) throw new Error('O Git não retornou a raiz do repositório.');
    const repoRoot = await fs.realpath(path.resolve(repoRootRaw));
    if (!isInside(repoRoot, projectRoot)) throw new Error('Projeto está fora da raiz Git detectada.');

    const gitDirRaw = (await runGit(projectRoot, ['rev-parse', '--absolute-git-dir'], 64 * 1024)).trim();
    if (!gitDirRaw) throw new Error('O Git não retornou o diretório de metadados.');
    const gitDir = await fs.realpath(path.resolve(gitDirRaw));

    const indexPathRaw = (await runGit(
      projectRoot,
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      64 * 1024,
    )).trim();
    if (!indexPathRaw) throw new Error('O Git não retornou o caminho do index.');
    const indexPath = path.resolve(indexPathRaw);

    const projectPrefixRaw = path.relative(repoRoot, projectRoot).replaceAll('\\', '/');
    const projectPrefix = projectPrefixRaw ? normalizeRelativePath(projectPrefixRaw) : '';

    const tracked = parseNullSeparated(await runGit(repoRoot, ['ls-files', '-z'], MAX_PATH_LIST_OUTPUT));
    const untracked = parseNullSeparated(await runGit(
      repoRoot,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      MAX_PATH_LIST_OUTPUT,
    ));

    return {
      projectRoot,
      repoRoot,
      gitDir,
      indexPath,
      projectPrefix,
      visibleGeneratedSegments: visibleGeneratedSegments([...tracked, ...untracked]),
    };
  }

  private async materialize(chatId: string, runId: string, projectId: string): Promise<MaterializedShadowGit> {
    const shadow = this.shadows.get(chatId, runId);
    if (!shadow) throw new Error('Shadow Workspace ativo não encontrado para a visão Git isolada.');
    if (shadow.projectId !== projectId) throw new Error('Shadow Workspace pertence a outro projeto.');

    const context = await this.repositoryContext(projectId);
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-git-'));
    const sandboxRoot = path.join(temporaryRoot, 'worktree');
    const sandboxIndex = path.join(temporaryRoot, 'index');
    let ready = false;

    try {
      await fs.cp(context.repoRoot, sandboxRoot, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
        preserveTimestamps: false,
        mode: fsConstants.COPYFILE_FICLONE,
        filter: async (source) => {
          const relative = path.relative(context.repoRoot, source);
          if (!relative) return true;
          const segments = relative.split(path.sep);
          if (segments.includes('.git')) return false;
          if (segments.some((segment) => generatedSegments.has(segment) && !context.visibleGeneratedSegments.has(segment))) {
            return false;
          }
          try {
            const stat = await fs.lstat(source);
            if (!stat.isSymbolicLink()) return true;
            const target = await fs.realpath(source);
            return isInside(context.repoRoot, target);
          } catch {
            return false;
          }
        },
      });

      try {
        await fs.copyFile(context.indexPath, sandboxIndex, fsConstants.COPYFILE_FICLONE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      for (const change of compactShadowWorkspaceChanges(shadow.changes)) {
        const relative = prefixedPath(context.projectPrefix, change.path);
        const destination = path.resolve(sandboxRoot, relative);
        if (!isInside(sandboxRoot, destination)) throw new Error('Alteração escapou da visão Git isolada.');

        if (change.type === 'deleted') {
          await fs.rm(destination, { force: true, recursive: false });
          continue;
        }
        if (change.type !== 'created' && change.type !== 'modified') {
          throw new Error('Tipo de alteração não materializável na visão Git isolada.');
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, change.after, 'utf8');
      }

      ready = true;
      return {
        context,
        sandbox: {
          rootPath: sandboxRoot,
          indexPath: sandboxIndex,
          cleanup: async () => {
            await fs.rm(temporaryRoot, { recursive: true, force: true });
          },
        },
      };
    } finally {
      if (!ready) await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private gitInSandbox(
    context: RepositoryContext,
    sandbox: ShadowGitSandbox,
    commandArgs: string[],
  ): Promise<string> {
    return runGit(
      sandbox.rootPath,
      [
        `--git-dir=${context.gitDir}`,
        `--work-tree=${sandbox.rootPath}`,
        '--no-pager',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        ...commandArgs,
      ],
      MAX_OUTPUT,
      sandbox.indexPath,
    );
  }
}
