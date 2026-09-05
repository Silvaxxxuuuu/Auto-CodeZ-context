import type { ProjectRecord } from '../ai/types';
import type { LocalStorage } from '../core/storage';
import { TerminalHistory, type TerminalHistoryRecord } from './terminal-history';
import type { InteractiveTerminalProcessFactory } from './terminal-process';
import { TerminalRuntime, type TerminalExitEvent, type TerminalOutputEvent, type TerminalSession } from './terminal-runtime';

export type TerminalEvent =
  | { type: 'output'; event: TerminalOutputEvent }
  | { type: 'exit'; event: TerminalExitEvent; session: TerminalSession; history: TerminalHistoryRecord };

const WRITE_MARKER = '__AUTO_CODEZ_WRITE__';
const SHELL_MARKER = /^__AUTO_CODEZ_SHELL__(cmd|powershell)$/;

export class TerminalService {
  private readonly history: TerminalHistory;
  private readonly runtime: TerminalRuntime;
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  constructor(
    private readonly storage: LocalStorage,
    projects: () => Promise<ProjectRecord[]>,
    interactiveFactory?: InteractiveTerminalProcessFactory,
  ) {
    this.history = new TerminalHistory(storage);
    this.runtime = new TerminalRuntime(projects, (event) => {
      if ('text' in event) {
        this.publish({ type: 'output', event });
        return;
      }
      void this.finish(event);
    }, interactiveFactory);
  }

  async init(): Promise<void> {
    await this.history.init();
  }

  async start(projectId: string, command: string): Promise<TerminalSession> {
    if (command.startsWith(WRITE_MARKER)) {
      let input: { sessionId?: unknown; command?: unknown };
      try {
        input = JSON.parse(command.slice(WRITE_MARKER.length)) as { sessionId?: unknown; command?: unknown };
      } catch {
        throw new Error('Comando interno do terminal inválido.');
      }
      if (typeof input.sessionId !== 'string' || typeof input.command !== 'string') throw new Error('Dados internos do terminal inválidos.');
      return this.runtime.write(input.sessionId, input.command);
    }

    const shellMatch = SHELL_MARKER.exec(command.trim());
    const session = await this.runtime.start(projectId, command);
    if (shellMatch && session.status === 'running') {
      const setup = session.shell === 'powershell'
        ? "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$env:TERM='xterm-256color';$env:FORCE_COLOR='1';$env:CLICOLOR_FORCE='1'"
        : 'chcp 65001>nul & set TERM=xterm-256color & set FORCE_COLOR=1 & set CLICOLOR_FORCE=1';
      try {
        this.runtime.write(session.id, setup);
      } catch {}
    }
    return session;
  }

  writeInput(sessionId: string, data: string): TerminalSession {
    return this.runtime.writeInput(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): TerminalSession {
    return this.runtime.resize(sessionId, cols, rows);
  }

  kill(sessionId: string): TerminalSession {
    return this.runtime.kill(sessionId);
  }

  listSessions(): Promise<TerminalSession[]> {
    return this.runtime.list();
  }

  getOutput(sessionId: string): string {
    return this.runtime.getOutput(sessionId);
  }

  listHistory(projectId?: string): Promise<TerminalHistoryRecord[]> {
    return this.history.list(projectId);
  }

  clearHistory(projectId?: string): Promise<void> {
    return this.history.clear(projectId);
  }

  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.runtime.dispose();
    this.listeners.clear();
  }

  private async finish(event: TerminalExitEvent): Promise<void> {
    const session = (await this.runtime.list()).find((item) => item.id === event.sessionId);
    if (!session || session.finishedAt === undefined || session.exitCode === undefined) return;
    const history = await this.history.add({
      projectId: session.projectId,
      command: session.command || `[${session.shell}]`,
      cwd: session.cwd,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      status: session.status === 'running' ? 'failed' : session.status,
      output: this.runtime.getOutput(session.id),
    });
    this.publish({ type: 'exit', event, session, history });
  }

  private publish(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}
