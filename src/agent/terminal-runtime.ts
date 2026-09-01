import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { ProjectRecord } from '../ai/types';

export interface TerminalOutputEvent {
  sessionId: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: string;
}

export interface TerminalSession {
  id: string;
  projectId: string;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  status: 'running' | 'exited' | 'failed' | 'killed';
}

interface SessionEntry {
  session: TerminalSession;
  child: ChildProcess;
  output: string;
  killRequested: boolean;
}

const MAX_SESSIONS = 50;
const MAX_OUTPUT_CHARS = 2_000_000;

function shellForPlatform(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    return { executable: comspec, args: ['/d', '/s', '/c', command] };
  }
  return { executable: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

export class TerminalRuntime {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly projects: () => Promise<ProjectRecord[]>, private readonly emit: (event: TerminalOutputEvent | TerminalExitEvent) => void) {}

  async list(): Promise<TerminalSession[]> {
    return [...this.sessions.values()].map(({ session }) => ({ ...session })).sort((a, b) => b.startedAt - a.startedAt);
  }

  private async project(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  async start(projectId: string, command: string): Promise<TerminalSession> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('Comando vazio.');
    if (normalizedCommand.length > 20_000) throw new Error('Comando excede o limite permitido.');
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Limite de sessões do terminal atingido.');

    const project = await this.project(projectId);
    const cwd = await fs.realpath(path.resolve(project.rootPath));
    const { executable, args } = shellForPlatform(normalizedCommand);
    const id = crypto.randomUUID();
    const session: TerminalSession = { id, projectId, command: normalizedCommand, cwd, startedAt: Date.now(), status: 'running' };
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env },
    });
    const entry: SessionEntry = { session, child, output: '', killRequested: false };
    this.sessions.set(id, entry);

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      entry.output = (entry.output + text).slice(-MAX_OUTPUT_CHARS);
      try { this.emit({ sessionId: id, stream, text }); } catch { /* observers are isolated from the process */ }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
    child.once('error', (error) => {
      if (session.finishedAt !== undefined) return;
      session.status = entry.killRequested ? 'killed' : 'failed';
      session.finishedAt = Date.now();
      session.exitCode = entry.killRequested ? 1 : 1;
      session.signal = entry.killRequested ? 'SIGTERM' : error.message;
      try { this.emit({ sessionId: id, exitCode: session.exitCode, signal: session.signal }); } catch { /* observers are isolated */ }
    });
    child.once('close', (exitCode, signal) => {
      if (session.finishedAt !== undefined) return;
      session.finishedAt = Date.now();
      session.exitCode = exitCode ?? 1;
      session.signal = signal ?? (entry.killRequested ? 'SIGTERM' : undefined);
      session.status = entry.killRequested || Boolean(signal) ? 'killed' : session.exitCode === 0 ? 'exited' : 'failed';
      try { this.emit({ sessionId: id, exitCode: session.exitCode, signal: session.signal }); } catch { /* observers are isolated */ }
    });

    return { ...session };
  }

  kill(sessionId: string): TerminalSession {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Sessão do terminal não encontrada.');
    if (entry.session.status !== 'running') return { ...entry.session };
    entry.killRequested = true;
    if (process.platform === 'win32' && entry.child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      killer.unref();
    } else if (entry.child.pid) {
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch { entry.child.kill('SIGTERM'); }
    } else {
      entry.child.kill('SIGTERM');
    }
    return { ...entry.session };
  }

  getOutput(sessionId: string): string {
    return this.sessions.get(sessionId)?.output ?? '';
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      if (entry.session.status === 'running') {
        entry.killRequested = true;
        try { entry.child.kill('SIGTERM'); } catch { /* process already gone */ }
      }
    }
    this.sessions.clear();
  }
}
