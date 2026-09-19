import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ProjectRecord } from '../ai/types';
import { currentAbortSignal } from '../ai/request-cancellation';
import { normalizeUnicodeText } from '../core/unicode-normalization';
import { SYSTEM_WORKSPACE_ID, getSystemWorkspaceRoot } from './system-workspace';

export const SYSTEM_PROJECT_ID = SYSTEM_WORKSPACE_ID;

export interface CommandOutputEvent {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface CommandRunOptions {
  onOutput?: (event: CommandOutputEvent) => void;
  signal?: AbortSignal;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

const MAX_OUTPUT_CHARS = 2_000_000;
const TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 2_000;
const blockedEnvironmentNames = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_SEQUENCE_EDITOR',
  'GIT_EDITOR',
  'GIT_PAGER',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_GLOBALCONFIG',
  'YARN_RC_FILENAME',
  'NODE_OPTIONS',
  'BASH_ENV',
  'KSH_ENV',
  'RUBYOPT',
  'PERL5OPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'DOTNET_STARTUP_HOOKS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'CLOUDSDK_CONFIG',
  'AZURE_CONFIG_DIR',
  'NETRC',
]);
const blockedEnvironmentPrefixes = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];
const sensitiveEnvironmentNamePattern = /(?:^|[_-])(?:token|auth[_-]?token|authtoken|secret|password|passwd|passphrase|credentials?|api[_-]?key|access[_-]?key|private[_-]?key)(?:$|[_-])/i;

function createCommandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalizedName = name.toUpperCase();
    if (
      blockedEnvironmentNames.has(normalizedName)
      || blockedEnvironmentPrefixes.some((prefix) => normalizedName.startsWith(prefix))
      || sensitiveEnvironmentNamePattern.test(normalizedName)
    ) continue;
    environment[name] = value;
  }
  environment.CI = source.CI ?? '1';
  return environment;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

async function runWindowsTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      finish();
    }, 1_500);
    killer.once('error', finish);
    killer.once('exit', finish);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;

  if (process.platform === 'win32' && child.pid) {
    await runWindowsTaskkill(child.pid);
    if (await waitForChildClose(child, 750)) return;
    try { child.kill('SIGKILL'); } catch {}
    await waitForChildClose(child, 750);
    return;
  }

  if (child.pid === undefined) {
    try { child.kill('SIGTERM'); } catch {}
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  if (await waitForChildClose(child, TERMINATION_GRACE_MS)) return;
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
  await waitForChildClose(child, 500);
}

function commandForPlatform(command: string, environment: NodeJS.ProcessEnv): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe';
    return { executable: comspec, args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`] };
  }
  return { executable: '/bin/sh', args: ['-lc', command] };
}

function commandFailureMessage(result: CommandResult): string {
  const details = result.stderr.trim() || result.stdout.trim();
  const suffix = details ? `\n${details}` : '';
  return `O comando terminou com código ${result.exitCode}.${suffix}`;
}

function createAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Operação cancelada.');
  error.name = 'AbortError';
  return error;
}

export class CommandRuntime {
  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  private async project(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  async run(projectId: string, command: string, options: CommandRunOptions = {}): Promise<CommandResult> {
    const normalizedCommand = normalizeUnicodeText(command.trim());
    if (!normalizedCommand) throw new Error('O comando não pode estar vazio.');
    const executionSignal = options.signal ?? currentAbortSignal();
    executionSignal?.throwIfAborted();

    const cwd = projectId === SYSTEM_PROJECT_ID
      ? await fs.realpath(getSystemWorkspaceRoot())
      : await fs.realpath(path.resolve((await this.project(projectId)).rootPath));
    executionSignal?.throwIfAborted();
    const environment = createCommandEnvironment(this.parentEnvironment);
    const { executable, args } = commandForPlatform(normalizedCommand, environment);
    const startedAt = Date.now();

    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
        detached: process.platform !== 'win32',
        env: environment,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let terminationPromise: Promise<void> | undefined;

      const cleanup = (): void => {
        clearTimeout(timeout);
        executionSignal?.removeEventListener('abort', abort);
      };

      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const decoded = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const value = normalizeUnicodeText(decoded);
        if (target === 'stdout') stdout = (stdout + value).slice(-MAX_OUTPUT_CHARS);
        else stderr = (stderr + value).slice(-MAX_OUTPUT_CHARS);
        try {
          options.onOutput?.({ stream: target, text: value });
        } catch {
        }
      };

      const beginTermination = (): Promise<void> => {
        terminationPromise ??= terminateProcessTree(child);
        return terminationPromise;
      };

      const abort = (): void => {
        if (settled || aborted) return;
        aborted = true;
        void beginTermination().then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(createAbortError(executionSignal));
        });
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        void beginTermination().then(() => {
          if (settled) return;
          finish({
            command: normalizedCommand,
            exitCode: 1,
            stdout,
            stderr: `${stderr}\nCommand timed out after ${TIMEOUT_MS / 60000} minutes.`.trim(),
            timedOut: true,
          });
        });
      }, TIMEOUT_MS);

      const finish = (partial: Omit<CommandResult, 'startedAt' | 'finishedAt' | 'durationMs'>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const finishedAt = Date.now();
        resolve({ ...partial, startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt) });
      };

      child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        if (aborted) {
          settled = true;
          cleanup();
          reject(createAbortError(executionSignal));
          return;
        }
        finish({
          command: normalizedCommand,
          exitCode: exitCode ?? (signal ? 1 : 0),
          stdout,
          stderr: timedOut ? `${stderr}\nCommand timed out after ${TIMEOUT_MS / 60000} minutes.`.trim() : stderr,
          timedOut,
        });
      });

      if (executionSignal?.aborted) abort();
      else executionSignal?.addEventListener('abort', abort, { once: true });
    });

    if (result.exitCode !== 0 || result.timedOut) throw new Error(commandFailureMessage(result));
    return result;
  }
}
