import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TerminalRuntime, type TerminalOutputEvent, type TerminalExitEvent } from '../src/agent/terminal-runtime';
import type {
  InteractiveTerminalProcess,
  InteractiveTerminalProcessFactory,
  TerminalProcessExit,
  TerminalProcessOptions,
} from '../src/agent/terminal-process';
import type { ProjectRecord } from '../src/ai/types';

async function createProject(factory?: InteractiveTerminalProcessFactory): Promise<{ root: string; runtime: TerminalRuntime; events: Array<TerminalOutputEvent | TerminalExitEvent>; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-terminal-test-'));
  const project: ProjectRecord = { id: 'terminal-project', name: 'Terminal Test', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const events: Array<TerminalOutputEvent | TerminalExitEvent> = [];
  return {
    root,
    events,
    runtime: new TerminalRuntime(async () => [project], (event) => events.push(event), factory),
    cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 10 : 0, retryDelay: 50 }),
  };
}

class FakeInteractiveProcess implements InteractiveTerminalProcess {
  readonly pid = 4321;
  readonly supportsResize = true;
  readonly writes: string[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: TerminalProcessExit) => void>();
  private errorListeners = new Set<(error: Error) => void>();

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push({ cols, rows }); }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void): () => void { this.dataListeners.add(listener); return () => this.dataListeners.delete(listener); }
  onExit(listener: (event: TerminalProcessExit) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  onError(listener: (error: Error) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
  emitExit(event: TerminalProcessExit): void { for (const listener of this.exitListeners) listener(event); }
  emitError(error: Error): void { for (const listener of this.errorListeners) listener(error); }
}

class FakeInteractiveFactory implements InteractiveTerminalProcessFactory {
  readonly created: Array<{ options: TerminalProcessOptions; process: FakeInteractiveProcess }> = [];
  create(options: TerminalProcessOptions): InteractiveTerminalProcess {
    const process = new FakeInteractiveProcess();
    this.created.push({ options, process });
    return process;
  }
}

const nodeCommand = (expression: string): string => process.platform === 'win32'
  ? `node -e "${expression.replaceAll('"', '\\"')}"`
  : `node -e '${expression.replaceAll("'", "'\\''")}'`;

async function waitForExit(runtime: TerminalRuntime, sessionId: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let current = (await runtime.list()).find((item) => item.id === sessionId);
  while (current?.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = (await runtime.list()).find((item) => item.id === sessionId) ?? current;
  }
  assert.ok(current, 'Sessão não encontrada durante a espera.');
  assert.notEqual(current.status, 'running', 'Processo não terminou dentro do prazo.');
  return current;
}

test('terminal runtime starts a project-scoped process and streams output', async () => {
  const fixture = await createProject();
  try {
    const session = await fixture.runtime.start('terminal-project', nodeCommand("process.stdout.write('terminal-ok')"));
    const current = await waitForExit(fixture.runtime, session.id);
    assert.equal(current.exitCode, 0);
    assert.equal(current.interactive, false);
    assert.equal(current.pty, false);
    assert.equal(fixture.runtime.getOutput(session.id), 'terminal-ok');
    assert.ok(fixture.events.some((event) => 'stream' in event && event.text.includes('terminal-ok')));
    assert.ok(fixture.events.some((event) => 'exitCode' in event && event.exitCode === 0));
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});

test('terminal runtime exposes raw input and resize through the interactive transport contract', async () => {
  const factory = new FakeInteractiveFactory();
  const fixture = await createProject(factory);
  try {
    const session = await fixture.runtime.start('__global__', '__AUTO_CODEZ_SHELL__powershell');
    assert.equal(session.interactive, true);
    assert.equal(session.pty, true);
    assert.equal(session.cols, 120);
    assert.equal(session.rows, 30);
    assert.equal(factory.created.length, 1);
    assert.equal(factory.created[0].options.shell, 'powershell');

    fixture.runtime.writeInput(session.id, 'abc\u0003');
    fixture.runtime.resize(session.id, 180, 48);
    factory.created[0].process.emitData('\u001b[32mready\u001b[0m');

    assert.deepEqual(factory.created[0].process.writes, ['abc\u0003']);
    assert.deepEqual(factory.created[0].process.sizes, [{ cols: 180, rows: 48 }]);
    assert.equal(fixture.runtime.getOutput(session.id), '\u001b[32mready\u001b[0m');
    const current = (await fixture.runtime.list()).find((item) => item.id === session.id);
    assert.equal(current?.cols, 180);
    assert.equal(current?.rows, 48);

    factory.created[0].process.emitExit({ exitCode: 0 });
    const exited = await waitForExit(fixture.runtime, session.id);
    assert.equal(exited.status, 'exited');
    assert.equal(exited.exitCode, 0);
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});

test('terminal runtime rejects invalid interactive input and resize values', async () => {
  const factory = new FakeInteractiveFactory();
  const fixture = await createProject(factory);
  try {
    const interactive = await fixture.runtime.start('__global__', '__AUTO_CODEZ_SHELL__cmd');
    const command = await fixture.runtime.start('terminal-project', nodeCommand("process.stdout.write('ok')"));

    assert.throws(() => fixture.runtime.writeInput(interactive.id, 'x'.repeat(65_537)), /excede o limite/);
    assert.throws(() => fixture.runtime.resize(interactive.id, 1, 30), /colunas/);
    assert.throws(() => fixture.runtime.resize(interactive.id, 120, 0), /linhas/);
    assert.throws(() => fixture.runtime.writeInput(command.id, 'abc'), /não aceita entrada interativa/);
    assert.throws(() => fixture.runtime.resize(command.id, 120, 30), /não suporta redimensionamento/);

    factory.created[0].process.emitExit({ exitCode: 0 });
    await waitForExit(fixture.runtime, command.id);
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});

test('terminal runtime rejects an empty command and unknown project', async () => {
  const fixture = await createProject();
  try {
    await assert.rejects(fixture.runtime.start('terminal-project', '   '), /Comando vazio/);
    await assert.rejects(fixture.runtime.start('missing-project', 'echo test'), /Projeto não encontrado/);
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});

test('terminal runtime preserves killed status until the process exits', async () => {
  const fixture = await createProject();
  try {
    const command = process.platform === 'win32' ? 'ping 127.0.0.1 -n 30 > nul' : 'sleep 30';
    const session = await fixture.runtime.start('terminal-project', command);
    const immediatelyAfterKill = fixture.runtime.kill(session.id);
    assert.equal(immediatelyAfterKill.status, 'running');
    const current = await waitForExit(fixture.runtime, session.id);
    assert.equal(current.status, 'killed');
    assert.equal(current.signal, 'SIGTERM');
    const exitEvents = fixture.events.filter((event): event is TerminalExitEvent => 'exitCode' in event);
    assert.equal(exitEvents.length, 1);
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});

test('terminal runtime keeps a failed process distinct from an intentional kill', async () => {
  const fixture = await createProject();
  try {
    const session = await fixture.runtime.start('terminal-project', nodeCommand('process.exit(7)'));
    const current = await waitForExit(fixture.runtime, session.id);
    assert.equal(current.status, 'failed');
    assert.equal(current.exitCode, 7);
    assert.equal(current.signal, undefined);
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});

test('terminal runtime prunes the oldest completed sessions before rejecting new work', async () => {
  const fixture = await createProject();
  try {
    const completed: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const session = await fixture.runtime.start('terminal-project', nodeCommand(`process.stdout.write('${index}')`));
      completed.push(session.id);
      await waitForExit(fixture.runtime, session.id);
    }

    assert.equal((await fixture.runtime.list()).length, 50);

    const replacement = await fixture.runtime.start('terminal-project', nodeCommand("process.stdout.write('replacement')"));
    await waitForExit(fixture.runtime, replacement.id);

    const sessions = await fixture.runtime.list();
    assert.equal(sessions.length, 50);
    assert.equal(sessions.some((session) => session.id === completed[0]), false);
    assert.equal(sessions.some((session) => session.id === replacement.id), true);
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});
