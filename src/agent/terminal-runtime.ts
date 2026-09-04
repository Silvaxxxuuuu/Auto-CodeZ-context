import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProjectRecord } from '../ai/types';

export type TerminalShell = 'cmd' | 'powershell';
export interface TerminalOutputEvent { sessionId: string; stream: 'stdout' | 'stderr'; text: string; }
export interface TerminalExitEvent { sessionId: string; exitCode: number; signal?: string; }
export interface TerminalSession { id: string; projectId: string; shell: TerminalShell; cwd: string; command: string; startedAt: number; finishedAt?: number; exitCode?: number; signal?: string; status: 'running' | 'exited' | 'failed' | 'killed'; }
interface SessionEntry { session: TerminalSession; child: ChildProcessWithoutNullStreams; output: string; killRequested: boolean; }
const MAX_SESSIONS = 12;
const MAX_OUTPUT_CHARS = 2_000_000;

function shellCommand(shell: TerminalShell): { file: string; args: string[] } {
  if (shell === 'powershell') return { file: process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'] };
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/Q'] };
}

export class TerminalRuntime {
  private readonly sessions = new Map<string, SessionEntry>();
  constructor(private readonly projects: () => Promise<ProjectRecord[]>, private readonly emit: (event: TerminalOutputEvent | TerminalExitEvent) => void) {}

  async list(): Promise<TerminalSession[]> { return [...this.sessions.values()].map(({ session }) => ({ ...session })).sort((a, b) => b.startedAt - a.startedAt); }

  async start(projectId: string, command: string): Promise<TerminalSession> {
    const marker = /^__AUTO_CODEZ_SHELL__(cmd|powershell)$/.exec(command.trim());
    const shell: TerminalShell = marker?.[1] === 'cmd' ? 'cmd' : 'powershell';
    if (marker) {
      this.pruneFinishedSessions();
      if (this.sessions.size >= MAX_SESSIONS) throw new Error('Limite de sessões do terminal atingido.');
      const cwd = process.env.USERPROFILE || os.homedir();
      const id = crypto.randomUUID();
      const session: TerminalSession = { id, projectId: '__global__', shell, command: '', cwd, startedAt: Date.now(), status: 'running' };
      const spec = shellCommand(shell);
      const child = spawn(spec.file, spec.args, { cwd, windowsHide: true, stdio: 'pipe', env: { ...process.env } });
      const entry: SessionEntry = { session, child, output: '', killRequested: false };
      this.sessions.set(id, entry);
      this.attach(entry);
      return { ...session };
    }
    return this.startCommand(projectId, command);
  }

  write(sessionId: string, command: string): TerminalSession {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.status !== 'running') throw new Error('Sessão do terminal não está em execução.');
    const value = command.trim();
    if (!value) return { ...entry.session };
    if (value.length > 20_000) throw new Error('Comando excede o limite permitido.');
    entry.session.command = value;
    entry.child.stdin.write(`${value}\r\n`);
    return { ...entry.session };
  }

  kill(sessionId: string): TerminalSession {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Sessão do terminal não encontrada.');
    if (entry.session.status !== 'running') return { ...entry.session };
    entry.killRequested = true;
    if (entry.child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      killer.unref();
    } else entry.child.kill();
    return { ...entry.session };
  }

  getOutput(sessionId: string): string { return this.sessions.get(sessionId)?.output ?? ''; }
  dispose(): void { for (const entry of this.sessions.values()) if (entry.session.status === 'running') { entry.killRequested = true; try { entry.child.kill(); } catch {} } this.sessions.clear(); }

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
    const session: TerminalSession = { id, projectId, shell: 'cmd', command: normalizedCommand, cwd, startedAt: Date.now(), status: 'running' };
    const child = spawn(normalizedCommand, { cwd, shell: true, windowsHide: true, detached: false, env: { ...process.env }, stdio: 'pipe' });
    const entry: SessionEntry = { session, child, output: '', killRequested: false };
    this.sessions.set(id, entry);
    this.attach(entry);
    return { ...session };
  }

  private attach(entry: SessionEntry): void {
    const { session, child } = entry;
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      entry.output = (entry.output + text).slice(-MAX_OUTPUT_CHARS);
      try { this.emit({ sessionId: session.id, stream, text }); } catch { /* terminal listeners are isolated */ }
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => this.finish(entry, entry.killRequested ? 'killed' : 'failed', 1, entry.killRequested ? 'SIGTERM' : error.message));
    child.once('close', (exitCode, signal) => this.finish(entry, entry.killRequested || Boolean(signal) ? 'killed' : exitCode === 0 ? 'exited' : 'failed', exitCode ?? 1, signal ?? undefined));
  }

  private pruneFinishedSessions(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const finished = [...this.sessions.entries()].filter(([, entry]) => entry.session.status !== 'running').sort(([, a], [, b]) => (a.session.finishedAt ?? a.session.startedAt) - (b.session.finishedAt ?? b.session.startedAt));
    while (this.sessions.size >= MAX_SESSIONS && finished.length) this.sessions.delete(finished.shift()![0]);
  }

  private finish(entry: SessionEntry, status: TerminalSession['status'], exitCode: number, signal?: string): void {
    if (entry.session.finishedAt !== undefined) return;
    entry.session.finishedAt = Date.now();
    entry.session.exitCode = exitCode;
    entry.session.signal = signal;
    entry.session.status = status;
    try { this.emit({ sessionId: entry.session.id, exitCode, signal }); } catch { /* terminal listeners are isolated */ }
  }
}
