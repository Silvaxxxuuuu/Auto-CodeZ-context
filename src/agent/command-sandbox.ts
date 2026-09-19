import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { compactShadowWorkspaceChanges } from '../shadow-workspace-publication';
import { CommandRuntime, SYSTEM_PROJECT_ID, type CommandResult, type CommandRunOptions } from './command-runtime';
import { getSystemWorkspaceRoot } from './system-workspace';
import { WorkspacePathPolicy } from './workspace-path-policy';

const ignoredSegments = new Set(['.git', '.vite', '.test-dist', 'dist', 'build', 'out', 'coverage']);
const COMMAND_SANDBOX_PROJECT_ID = '__auto_codez_command_sandbox__';

export type MaterializedCommandSandbox = {
  rootPath: string;
  homePath: string;
  tempPath: string;
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

function isolatedCommandEnvironment(base: NodeJS.ProcessEnv, sandbox: MaterializedCommandSandbox): NodeJS.ProcessEnv {
  const appData = path.join(sandbox.homePath, 'AppData', 'Roaming');
  const localAppData = path.join(sandbox.homePath, 'AppData', 'Local');
  const environment: NodeJS.ProcessEnv = {
    ...base,
    HOME: sandbox.homePath,
    USERPROFILE: sandbox.homePath,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: path.join(sandbox.homePath, '.config'),
    XDG_CACHE_HOME: path.join(sandbox.homePath, '.cache'),
    XDG_DATA_HOME: path.join(sandbox.homePath, '.local', 'share'),
    TEMP: sandbox.tempPath,
    TMP: sandbox.tempPath,
    TMPDIR: sandbox.tempPath,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: sandbox.rootPath,
  };

  if (process.platform === 'win32') {
    const root = path.parse(sandbox.homePath).root;
    const drive = root.replace(/[\\/]+$/, '');
    environment.HOMEDRIVE = drive;
    environment.HOMEPATH = sandbox.homePath.slice(drive.length) || '\\';
  }

  return environment;
}

export class CommandSandboxMaterializer {
  private readonly pathPolicy = new WorkspacePathPolicy();

  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly systemWorkspaceRoot: () => string = getSystemWorkspaceRoot,
  ) {}

  async materialize(projectId: string, changes: ReturnType<typeof compactShadowWorkspaceChanges>): Promise<MaterializedCommandSandbox> {
    let sourcePath: string;
    if (projectId === SYSTEM_PROJECT_ID) {
      sourcePath = this.systemWorkspaceRoot();
    } else {
      const project = (await this.projects()).find((item) => item.id === projectId);
      if (!project) throw new Error('Projeto não encontrado para o command sandbox.');
      sourcePath = project.rootPath;
    }

    const sourceRoot = await fs.realpath(path.resolve(sourcePath));
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-sandbox-'));
    const sandboxRoot = path.join(temporaryRoot, 'workspace');
    const homePath = path.join(temporaryRoot, 'home');
    const tempPath = path.join(temporaryRoot, 'tmp');
    let ready = false;

    try {
      await Promise.all([
        fs.mkdir(path.join(homePath, 'AppData', 'Roaming'), { recursive: true }),
        fs.mkdir(path.join(homePath, 'AppData', 'Local'), { recursive: true }),
        fs.mkdir(path.join(homePath, '.config'), { recursive: true }),
        fs.mkdir(path.join(homePath, '.cache'), { recursive: true }),
        fs.mkdir(path.join(homePath, '.local', 'share'), { recursive: true }),
        fs.mkdir(tempPath, { recursive: true }),
      ]);

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
        homePath,
        tempPath,
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
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
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
      const environment = isolatedCommandEnvironment(this.parentEnvironment, sandbox);
      const sandboxProject: ProjectRecord = {
        id: COMMAND_SANDBOX_PROJECT_ID,
        name: 'Command Sandbox',
        rootPath: sandbox.rootPath,
        createdAt: 0,
        updatedAt: 0,
      };
      const runtime = new CommandRuntime(async () => [sandboxProject], environment);
      return await runtime.run(COMMAND_SANDBOX_PROJECT_ID, command, options);
    } finally {
      await sandbox.cleanup();
    }
  }
}
