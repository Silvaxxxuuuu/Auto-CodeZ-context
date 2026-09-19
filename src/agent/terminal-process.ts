import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type TerminalShell = 'cmd' | 'powershell';

export type TerminalProcessExit = {
  exitCode: number;
  signal?: string;
};

export type TerminalProcessOptions = {
  shell: TerminalShell;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
};

export interface InteractiveTerminalProcess {
  readonly pid?: number;
  readonly supportsResize: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: TerminalProcessExit) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export interface InteractiveTerminalProcessFactory {
  create(options: TerminalProcessOptions): InteractiveTerminalProcess;
}

export function resolveTerminalShell(shell: TerminalShell): { file: string; args: string[] } {
  if (shell === 'powershell') {
    return {
      file: process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'],
    };
  }
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/Q'] };
}

class PipeInteractiveTerminalProcess implements InteractiveTerminalProcess {
  readonly supportsResize = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  write(data: string): void {
    if (!this.child.stdin.writable) throw new Error('Entrada do terminal não está disponível.');
    this.child.stdin.write(data);
  }

  resize(cols: number, rows: number): void {
    void cols;
    void rows;
  }

  kill(): void {
    this.child.kill();
  }

  onData(listener: (data: string) => void): () => void {
    const stdout = (chunk: Buffer | string): void => listener(chunk.toString());
    const stderr = (chunk: Buffer | string): void => listener(chunk.toString());
    this.child.stdout.on('data', stdout);
    this.child.stderr.on('data', stderr);
    return () => {
      this.child.stdout.off('data', stdout);
      this.child.stderr.off('data', stderr);
    };
  }

  onExit(listener: (event: TerminalProcessExit) => void): () => void {
    const handler = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      listener({ exitCode: exitCode ?? 1, signal: signal ?? undefined });
    };
    this.child.once('close', handler);
    return () => this.child.off('close', handler);
  }

  onError(listener: (error: Error) => void): () => void {
    const handler = (error: Error): void => listener(error);
    this.child.once('error', handler);
    return () => this.child.off('error', handler);
  }
}

export class PipeInteractiveTerminalProcessFactory implements InteractiveTerminalProcessFactory {
  create(options: TerminalProcessOptions): InteractiveTerminalProcess {
    const spec = resolveTerminalShell(options.shell);
    const child = spawn(spec.file, spec.args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: 'pipe',
      env: options.env,
    });
    return new PipeInteractiveTerminalProcess(child);
  }
}
