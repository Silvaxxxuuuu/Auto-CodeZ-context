import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { compactShadowWorkspaceChanges } from '../shadow-workspace-publication';
import { CommandRuntime, SYSTEM_PROJECT_ID, type CommandResult, type CommandRunOptions } from './command-runtime';
import { WorkspacePathPolicy } from './workspace-path-policy';

const ignoredSegments = new Set(['.git', '.vite', '.test-dist', 'dist', 'build', 'out', 'coverage']);

export type MaterializedCommandSandbox = {
  rootPath: string;
  cleanup(): Promise<void>;
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(normalized)) {
    throw new Error('Caminho inválido para o command sandbox.');
  }
  return normalized;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isAllowedSandboxSource(relative: string, policy: WorkspacePathPolicy): boolean {
  const normalized = normalizeRelativePath(relative);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ignoredSegments.has(segment.toLowerCase()))) return false;
  return policy.evaluate('read_file', [normalized]).decision === 'allow';
}

export class CommandSandboxMaterializer {
  private readonly pathPolicy = new WorkspacePathPolicy();

  constructor(private readonly projects: () => Promise<ProjectRecord[]>) {}

  async materialize(projectId: string, changes: ReturnType<typeof compactShadowWorkspaceChanges>): Promise<MaterializedCommandSandbox> {
    if (projectId === SYSTEM_PROJECT_ID) throw new Error('Command sandbox não materializa o workspace de sistema.');
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado para o command sandbox.');

    const sourceRoot = await fs.realpath(path.resolve(project.rootPath));
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-sandbox-'));
    const sandboxRoot = path.join(temporaryRoot, 'workspace');
    let ready = false;

    try {
      await fs.cp(sourceRoot, sandboxRoot, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
        preserveTimestamps: false,
        mode: fsConstants.COPYFILE_FICLONE,
        filter: async (source) => {
          const relative = path.relative(sourceRoot, source);
          if (!relative) return true;
          if (!isAllowedSandboxSource(relative, this.pathPolicy)) return false;
          try {
            const stat = await fs.lstat(source);
            if (!stat.isSymbolicLink()) return true;
            const target = await fs.realpath(source);
            if (!isInside(sourceRoot, target)) return false;
            const targetRelative = path.relative(sourceRoot, target);
            if (!targetRelative) return false;
            return isAllowedSandboxSource(targetRelative, this.pathPolicy);
          } catch {
            return false;
          }
        },
      });

      for (const change of compactShadowWorkspaceChanges(changes)) {
        const relative = safeRelativePath(change.path);
        if (this.pathPolicy.evaluate('read_file', [relative]).decision !== 'allow') {
          throw new Error('Shadow Workspace contém caminho sensível não materializável no command sandbox.');
        }
        const destination = path.resolve(sandboxRoot, relative);
        if (!isInside(sandboxRoot, destination)) throw new Error('Alteração escapou do command sandbox.');

        if (change.type === 'deleted') {
          await fs.rm(destination, { force: true, recursive: false });
          continue;
        }
        if (change.type !== 'created' && change.type !== 'modified') {
          throw new Error('Tipo de alteração não materializável no command sandbox.');
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, change.after, 'utf8');
      }

      ready = true;
      return {
        rootPath: sandboxRoot,
        cleanup: async () => {
          await fs.rm(temporaryRoot, { recursive: true, force: true });
        },
      };
    } finally {
      if (!ready) await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export class CommandSandboxRuntime {
  private readonly materializer: CommandSandboxMaterializer;

  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly shadows: ExecutionShadowWorkspaceRuntime,
    materializer?: CommandSandboxMaterializer,
  ) {
    this.materializer = materializer ?? new CommandSandboxMaterializer(projects);
  }

  async run(
    chatId: string,
    runId: string,
    projectId: string,
    command: string,
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    const shadow = this.shadows.get(chatId, runId);
    if (!shadow) throw new Error('Shadow Workspace ativo não encontrado para o command sandbox.');
    if (shadow.projectId !== projectId) throw new Error('Shadow Workspace pertence a outro projeto.');

    const sandbox = await this.materializer.materialize(projectId, shadow.changes);
    try {
      const project = (await this.projects()).find((item) => item.id === projectId);
      if (!project) throw new Error('Projeto não encontrado para executar o command sandbox.');
      const runtime = new CommandRuntime(async () => [{ ...project, rootPath: sandbox.rootPath }]);
      return await runtime.run(projectId, command, options);
    } finally {
      await sandbox.cleanup();
    }
  }
}
