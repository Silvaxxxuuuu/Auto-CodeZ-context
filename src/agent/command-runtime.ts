import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ProjectRecord } from '../ai/types';
import { SYSTEM_WORKSPACE_ID, getSystemWorkspaceRoot } from './system-workspace';

export const SYSTEM_PROJECT_ID = SYSTEM_WORKSPACE_ID;

export interface CommandOutputEvent {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface CommandRunOptions {
  onOutput?: (event: CommandOutputEvent) => void;
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

function terminateProcessTree(child: ChildProcess): void {
  if (child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    killer.unref();
    return;
  }
  if (child.pid === undefined) {
    child.kill('SIGTERM');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function commandForPlatform(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    return { executable: comspec, args: ['/d', '/s', '/c', command] };
  }
  return { executable: '/bin/sh', args: ['-lc', command] };
}

export class CommandRuntime {
  constructor(private readonly projects: () => Promise<ProjectRecord[]>) {}

  private async project(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  async run(projectId: string, command: string, options: CommandRunOptions = {}): Promise<CommandResult> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('O comando não pode estar vazio.');

    const cwd = projectId === SYSTEM_PROJECT_ID
      ? await fs.realpath(getSystemWorkspaceRoot())
      : await fs.realpath(path.resolve((await this.project(projectId)).rootPath));
    const { executable, args } = commandForPlatform(normalizedCommand);
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
        detached: process.platform !== 'win32',
        env: { ...process.env, CI: process.env.CI ?? '1' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const value = chunk.toString();
        if (target === 'stdout') stdout = (stdout + value).slice(-MAX_OUTPUT_CHARS);
        else stderr = (stderr + value).slice(-MAX_OUTPUT_CHARS);
        try {
          options.onOutput?.({ stream: target, text: value });
        } catch {
          // A UI observer must never be able to break the command process.
        }
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminateProcessTree(child);
        killTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, TERMINATION_GRACE_MS);
      }, TIMEOUT_MS);

      const finish = (result: Omit<CommandResult, 'startedAt' | 'finishedAt' | 'durationMs'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const finishedAt = Date.now();
        resolve({ ...result, startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt) });
      };

      child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
      child.on('error', (error) => {
        if (settled) return;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.on('close', (exitCode, signal) => finish({
        command: normalizedCommand,
        exitCode: exitCode ?? (signal ? 1 : 0),
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out after ${TIMEOUT_MS / 60000} minutes.`.trim() : stderr,
        timedOut,
      }));
    });
  }
}
