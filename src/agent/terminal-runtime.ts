import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProjectRecord } from '../ai/types';
import {
  PipeInteractiveTerminalProcessFactory,
  type InteractiveTerminalProcess,
  type InteractiveTerminalProcessFactory,
  type TerminalShell,
} from './terminal-process';

export type { TerminalShell } from './terminal-process';
export interface TerminalOutputEvent { sessionId: string; stream: 'stdout' | 'stderr'; text: string; }
export interface TerminalExitEvent { sessionId: string; exitCode: number; signal?: string; }
export interface TerminalSession {
  id: string;
  projectId: string;
  shell: TerminalShell;
  cwd: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  status: 'running' | 'exited' | 'failed' | 'killed';
  interactive: boolean;
  cols?: number;
  rows?: number;
  pty: boolean;
}

type BaseSessionEntry = {
  session: TerminalSession;
  output: string;
  killRequested: boolean;
};

type InteractiveSessionEntry = BaseSessionEntry & {
  kind: 'interactive';
  process: InteractiveTerminalProcess;
};

type CommandSessionEntry = BaseSessionEntry & {
  kind: 'command';
  child: ChildProcessWithoutNullStreams;
};

type SessionEntry = InteractiveSessionEntry | CommandSessionEntry;

const MAX_SESSIONS = 50;
const MAX_OUTPUT_CHARS = 2_000_000;
const MAX_INPUT_CHARS = 65_536;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000) throw new Error('Número de colunas do terminal inválido.');
  if (!Number.isInteger(rows) || rows < 1 || rows > 500) throw new Error('Número de linhas do terminal inválido.');
}

export class TerminalRuntime {
  private readonly sessions = new Map<string, SessionEntry>();
  private interactiveFactory: InteractiveTerminalProcessFactory;

  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly emit: (event: TerminalOutputEvent | TerminalExitEvent) => void,
    interactiveFactory: InteractiveTerminalProcessFactory = new PipeInteractiveTerminalProcessFactory(),
  ) {
    this.interactiveFactory = interactiveFactory;
  }

  configureInteractiveFactory(factory: InteractiveTerminalProcessFactory): void {
    if ([...this.sessions.values()].some((entry) => entry.session.status === 'running' && entry.session.interactive)) {
      throw new Error('Não é possível trocar o transporte do terminal com uma sessão interativa ativa.');
    }
    this.interactiveFactory = factory;
  }

  async list(): Promise<TerminalSession[]> {
    return [...this.sessions.values()]
      .map(({ session }) => ({ ...session }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async start(projectId: string, command: string): Promise<TerminalSession> {
    const marker = /^__AUTO_CODEZ_SHELL__(cmd|powershell)$/.exec(command.trim());
    const shell: TerminalShell = marker?.[1] === 'cmd' ? 'cmd' : 'powershell';
    if (marker) return this.startInteractiveShell(shell);
    return this.startCommand(projectId, command);
  }

  write(sessionId: string, command: string): TerminalSession {
    const value = command.trim();
    if (!value) return this.requireRunning(sessionId).session;
    if (value.length > 20_000) throw new Error('Comando excede o limite permitido.');
    const entry = this.requireRunning(sessionId);
    entry.session.command = value;
    this.writeToEntry(entry, `${value}\r\n`);
    return { ...entry.session };
  }

  writeInput(sessionId: string, data: string): TerminalSession {
    if (typeof data !== 'string') throw new Error('Entrada do terminal inválida.');
    if (data.length > MAX_INPUT_CHARS) throw new Error('Entrada do terminal excede o limite permitido.');
    const entry = this.requireRunning(sessionId);
    if (!entry.session.interactive) throw new Error('A sessão não aceita entrada interativa.');
    if (data) this.writeToEntry(entry, data);
    return { ...entry.session };
  }

  resize(sessionId: string, cols: number, rows: number): TerminalSession {
    validateSize(cols, rows);
    const entry = this.requireRunning(sessionId);
    if (!entry.session.interactive || entry.kind !== 'interactive') throw new Error('A sessão não suporta redimensionamento interativo.');
    entry.session.cols = cols;
    entry.session.rows = rows;
    if (entry.process.supportsResize) entry.process.resize(cols, rows);
    return { ...entry.session };
  }

  kill(sessionId: string): TerminalSession {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Sessão do terminal não encontrada.');
    if (entry.session.status !== 'running') return { ...entry.session };
    entry.killRequested = true;
    const pid = entry.kind === 'interactive' ? entry.process.pid : entry.child.pid;
    if (pid && process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      killer.unref();
    } else {
      try {
        if (entry.kind === 'interactive') entry.process.kill();
        else entry.child.kill();
      } catch {}
    }
    return { ...entry.session };
  }

  getOutput(sessionId: string): string {
    return this.sessions.get(sessionId)?.output ?? '';
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      if (entry.session.status !== 'running') continue;
      entry.killRequested = true;
      try {
        if (entry.kind === 'interactive') entry.process.kill();
        else entry.child.kill();
      } catch {}
    }
    this.sessions.clear();
  }

  private startInteractiveShell(shell: TerminalShell): TerminalSession {
    this.pruneFinishedSessions();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Limite de sessões do terminal atingido.');
    const cwd = process.env.USERPROFILE || os.homedir();
    const id = crypto.randomUUID();
    const processHandle = this.interactiveFactory.create({
      shell,
      cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: { ...process.env },
    });
    const session: TerminalSession = {
      id,
      projectId: '__global__',
      shell,
      command: '',
      cwd,
      startedAt: Date.now(),
      status: 'running',
      interactive: true,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      pty: processHandle.supportsResize,
    };
    const entry: InteractiveSessionEntry = {
      kind: 'interactive',
      session,
      process: processHandle,
      output: '',
      killRequested: false,
    };
    this.sessions.set(id, entry);
    this.attachInteractive(entry);
    return { ...session };
  }

  private async startCommand(projectId: string, command: string): Promise<TerminalSession> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('Comando vazio.');
    if (normalizedCommand.length > 20_000) throw new Error('Comando excede o limite permitido.');
    this.pruneFinishedSessions();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Limite de sessões do terminal atingido.');
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    const fs = await import('node:fs/promises');
    const cwd = await fs.realpath(path.resolve(project.rootPath));
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      projectId,
      shell: 'cmd',
      command: normalizedCommand,
      cwd,
      startedAt: Date.now(),
      status: 'running',
      interactive: false,
      pty: false,
    };
    const child = spawn(normalizedCommand, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: false,
      env: { ...process.env },
      stdio: 'pipe',
    });
    const entry: CommandSessionEntry = {
      kind: 'command',
      session,
      child,
      output: '',
      killRequested: false,
    };
    this.sessions.set(id, entry);
    this.attachCommand(entry);
    return { ...session };
  }

  private requireRunning(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.status !== 'running') throw new Error('Sessão do terminal não está em execução.');
    return entry;
  }

  private writeToEntry(entry: SessionEntry, data: string): void {
    if (entry.kind === 'interactive') {
      entry.process.write(data);
      return;
    }
    if (!entry.child.stdin.writable) throw new Error('Entrada do terminal não está disponível.');
    entry.child.stdin.write(data);
  }

  private appendOutput(entry: SessionEntry, stream: 'stdout' | 'stderr', text: string): void {
    entry.output = (entry.output + text).slice(-MAX_OUTPUT_CHARS);
    try {
      this.emit({ sessionId: entry.session.id, stream, text });
    } catch {}
  }

  private attachInteractive(entry: InteractiveSessionEntry): void {
    entry.process.onData((text) => this.appendOutput(entry, 'stdout', text));
    entry.process.onError((error) => this.finish(entry, entry.killRequested ? 'killed' : 'failed', 1, entry.killRequested ? 'SIGTERM' : error.message));
    entry.process.onExit((event) => {
      this.finish(
        entry,
        entry.killRequested || Boolean(event.signal) ? 'killed' : event.exitCode === 0 ? 'exited' : 'failed',
        event.exitCode,
        event.signal ?? (entry.killRequested ? 'SIGTERM' : undefined),
      );
    });
  }

  private attachCommand(entry: CommandSessionEntry): void {
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => this.appendOutput(entry, stream, chunk.toString());
    entry.child.stdout.on('data', (chunk) => append('stdout', chunk));
    entry.child.stderr.on('data', (chunk) => append('stderr', chunk));
    entry.child.once('error', (error) => this.finish(entry, entry.killRequested ? 'killed' : 'failed', 1, entry.killRequested ? 'SIGTERM' : error.message));
    entry.child.once('close', (exitCode, signal) => this.finish(entry, entry.killRequested || Boolean(signal) ? 'killed' : exitCode === 0 ? 'exited' : 'failed', exitCode ?? 1, signal ?? (entry.killRequested ? 'SIGTERM' : undefined)));
  }

  private pruneFinishedSessions(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const finished = [...this.sessions.entries()]
      .filter(([, entry]) => entry.session.status !== 'running')
      .sort(([, a], [, b]) => (a.session.finishedAt ?? a.session.startedAt) - (b.session.finishedAt ?? b.session.startedAt));
    while (this.sessions.size >= MAX_SESSIONS && finished.length) this.sessions.delete(finished.shift()![0]);
  }

  private finish(entry: SessionEntry, status: TerminalSession['status'], exitCode: number, signal?: string): void {
    if (entry.session.finishedAt !== undefined) return;
    entry.session.finishedAt = Date.now();
    entry.session.exitCode = exitCode;
    entry.session.signal = signal;
    entry.session.status = status;
    try {
      this.emit({ sessionId: entry.session.id, exitCode, signal });
    } catch {}
  }
}
