import {
  resolveTerminalShell,
  type InteractiveTerminalProcess,
  type InteractiveTerminalProcessFactory,
  type TerminalProcessExit,
  type TerminalProcessOptions,
} from './terminal-process';

type Disposable = { dispose: () => void };

type NodePtyExitEvent = {
  exitCode: number;
  signal?: number;
};

type NodePtyProcess = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => Disposable;
  onExit: (listener: (event: NodePtyExitEvent) => void) => Disposable;
};

export type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      useConpty?: boolean;
    },
  ) => NodePtyProcess;
};

function cleanEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  result.FORCE_COLOR = result.FORCE_COLOR || '1';
  return result;
}

class NodePtyInteractiveTerminalProcess implements InteractiveTerminalProcess {
  readonly supportsResize = true;

  constructor(private readonly process: NodePtyProcess) {}

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(): void {
    this.process.kill();
  }

  onData(listener: (data: string) => void): () => void {
    const disposable = this.process.onData(listener);
    return () => disposable.dispose();
  }

  onExit(listener: (event: TerminalProcessExit) => void): () => void {
    const disposable = this.process.onExit((event) => {
      listener({
        exitCode: event.exitCode,
        signal: event.signal === undefined ? undefined : String(event.signal),
      });
    });
    return () => disposable.dispose();
  }

  onError(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }
}

export class NodePtyInteractiveTerminalProcessFactory implements InteractiveTerminalProcessFactory {
  constructor(private readonly nodePty: NodePtyModule) {}

  create(options: TerminalProcessOptions): InteractiveTerminalProcess {
    const shell = resolveTerminalShell(options.shell);
    const processHandle = this.nodePty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: cleanEnvironment(options.env),
      useConpty: process.platform === 'win32',
    });
    return new NodePtyInteractiveTerminalProcess(processHandle);
  }
}
