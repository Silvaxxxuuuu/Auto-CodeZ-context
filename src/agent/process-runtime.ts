import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { ProjectRecord } from '../ai/types';
import { normalizeUnicodeText } from '../core/unicode-normalization';
import {
  SYSTEM_PROJECT_ID,
  commandForPlatform,
  createCommandEnvironment,
  terminateProcessTree,
} from './command-runtime';
import { getSystemWorkspaceRoot } from './system-workspace';

export type ManagedProcessStatus = 'running' | 'exited' | 'failed' | 'stopped';

export type ManagedProcessSnapshot = {
  id: string;
  projectId: string;
  command: string;
  status: ManagedProcessStatus;
  pid?: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  outputSequence: number;
};

export type ManagedProcessOutputEvent = {
  sequence: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: number;
};

export type ManagedProcessOutput = {
  process: ManagedProcessSnapshot;
  events: ManagedProcessOutputEvent[];
  nextSequence: number;
  truncated: boolean;
};

export type StartProcessOptions = {
  label?: string;
};

type ManagedProcessRecord = {
  snapshot: ManagedProcessSnapshot;
  child: ChildProcess;
  output: ManagedProcessOutputEvent[];
  outputChars: number;
  earliestSequence: number;
  waiters: Set<() => void>;
  stopping: boolean;
};

const MAX_BUFFER_CHARS = 1_000_000;
const MAX_OUTPUT_EVENTS = 4_000;

function cloneSnapshot(snapshot: ManagedProcessSnapshot): ManagedProcessSnapshot {
  return { ...snapshot };
}

function commandFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProcessRuntime {
  private readonly processes = new Map<string, ManagedProcessRecord>();

  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  private async project(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  private async cwd(projectId: string): Promise<string> {
    if (projectId === SYSTEM_PROJECT_ID) return fs.realpath(getSystemWorkspaceRoot());
    return fs.realpath(path.resolve((await this.project(projectId)).rootPath));
  }

  private record(processId: string): ManagedProcessRecord {
    const record = this.processes.get(processId);
    if (!record) throw new Error(`Processo persistente não encontrado: ${processId}.`);
    return record;
  }

  private notify(record: ManagedProcessRecord): void {
    const waiters = [...record.waiters];
    record.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  private append(record: ManagedProcessRecord, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const decoded = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const text = normalizeUnicodeText(decoded);
    if (!text) return;

    const event: ManagedProcessOutputEvent = {
      sequence: record.snapshot.outputSequence + 1,
      stream,
      text,
      at: Date.now(),
    };
    record.snapshot.outputSequence = event.sequence;
    record.output.push(event);
    record.outputChars += text.length;

    while (record.output.length > MAX_OUTPUT_EVENTS || record.outputChars > MAX_BUFFER_CHARS) {
      const removed = record.output.shift();
      if (!removed) break;
      record.outputChars -= removed.text.length;
      record.earliestSequence = removed.sequence + 1;
    }

  }

  async start(projectId: string, command: string, _options: StartProcessOptions = {}): Promise<ManagedProcessSnapshot> {
    const normalizedCommand = normalizeUnicodeText(command.trim());
    if (!normalizedCommand) throw new Error('O comando do processo não pode estar vazio.');

    const cwd = await this.cwd(projectId);
    const environment = createCommandEnvironment(this.parentEnvironment);
    const { executable, args } = commandForPlatform(normalizedCommand, environment);
    const id = this.createId();
    if (!id || this.processes.has(id)) throw new Error('Identificador de processo persistente inválido ou duplicado.');

    return new Promise<ManagedProcessSnapshot>((resolve, reject) => {
      let settledStart = false;
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
        detached: process.platform !== 'win32',
        env: environment,
      });
      const record: ManagedProcessRecord = {
        snapshot: {
          id,
          projectId,
          command: normalizedCommand,
          status: 'running',
          pid: child.pid,
          startedAt: Date.now(),
          outputSequence: 0,
        },
        child,
        output: [],
        outputChars: 0,
        earliestSequence: 1,
        waiters: new Set(),
        stopping: false,
      };
      this.processes.set(id, record);

      child.stdout?.on('data', (chunk: Buffer | string) => this.append(record, 'stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => this.append(record, 'stderr', chunk));

      child.once('spawn', () => {
        if (settledStart) return;
        settledStart = true;
        record.snapshot.pid = child.pid;
        resolve(cloneSnapshot(record.snapshot));
      });

      child.once('error', (error) => {
        record.snapshot.status = record.stopping ? 'stopped' : 'failed';
        record.snapshot.error = commandFailure(error);
        record.snapshot.finishedAt = Date.now();
        this.notify(record);
        if (!settledStart) {
          settledStart = true;
          reject(error);
        }
      });

      child.once('close', (exitCode, signal) => {
        if (record.snapshot.finishedAt !== undefined) return;
        record.snapshot.status = record.stopping ? 'stopped' : (exitCode === 0 ? 'exited' : 'failed');
        record.snapshot.exitCode = exitCode ?? (signal ? 1 : 0);
        record.snapshot.signal = signal ?? undefined;
        record.snapshot.finishedAt = Date.now();
        this.notify(record);
      });
    });
  }

  get(processId: string): ManagedProcessSnapshot {
    return cloneSnapshot(this.record(processId).snapshot);
  }

  list(projectId?: string): ManagedProcessSnapshot[] {
    return [...this.processes.values()]
      .map((record) => cloneSnapshot(record.snapshot))
      .filter((snapshot) => !projectId || snapshot.projectId === projectId)
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }

  readOutput(processId: string, afterSequence = 0): ManagedProcessOutput {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error('afterSequence deve ser um inteiro >= 0.');
    const record = this.record(processId);
    const truncated = afterSequence > 0 && afterSequence < record.earliestSequence - 1;
    const effectiveAfter = truncated ? record.earliestSequence - 1 : afterSequence;
    const events = record.output
      .filter((event) => event.sequence > effectiveAfter)
      .map((event) => ({ ...event }));
    return {
      process: cloneSnapshot(record.snapshot),
      events,
      nextSequence: events.at(-1)?.sequence ?? Math.max(afterSequence, record.snapshot.outputSequence),
      truncated,
    };
  }

  async wait(processId: string, timeoutMs?: number): Promise<ManagedProcessSnapshot> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new Error('timeoutMs deve ser um número >= 0.');
    }
    const record = this.record(processId);
    if (record.snapshot.status !== 'running') return cloneSnapshot(record.snapshot);
    if (timeoutMs === 0) return cloneSnapshot(record.snapshot);

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        record.waiters.delete(finish);
        resolve();
      };
      record.waiters.add(finish);
      if (timeoutMs !== undefined) timer = setTimeout(finish, timeoutMs);
      if (record.snapshot.status !== 'running') finish();
    });

    return cloneSnapshot(record.snapshot);
  }

  async stop(processId: string): Promise<ManagedProcessSnapshot> {
    const record = this.record(processId);
    if (record.snapshot.status !== 'running') return cloneSnapshot(record.snapshot);
    if (record.stopping) return this.wait(processId);

    record.stopping = true;
    await terminateProcessTree(record.child);
    if (record.snapshot.status === 'running') {
      record.snapshot.status = 'stopped';
      record.snapshot.finishedAt = Date.now();
      if (record.child.exitCode !== null) record.snapshot.exitCode = record.child.exitCode;
      if (record.child.signalCode) record.snapshot.signal = record.child.signalCode;
      this.notify(record);
    }
    return cloneSnapshot(record.snapshot);
  }

  async stopAll(projectId?: string): Promise<ManagedProcessSnapshot[]> {
    const targets = this.list(projectId).filter((snapshot) => snapshot.status === 'running');
    return Promise.all(targets.map((snapshot) => this.stop(snapshot.id)));
  }

  remove(processId: string): boolean {
    const record = this.record(processId);
    if (record.snapshot.status === 'running') throw new Error('Não é possível remover um processo ainda em execução.');
    return this.processes.delete(processId);
  }
}
