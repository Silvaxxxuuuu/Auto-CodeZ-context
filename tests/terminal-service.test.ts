import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalService } from '../src/agent/terminal-service';
import type {
  InteractiveTerminalProcess,
  InteractiveTerminalProcessFactory,
  TerminalProcessExit,
  TerminalProcessOptions,
} from '../src/agent/terminal-process';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, value);
  }
}

class FakeInteractiveProcess implements InteractiveTerminalProcess {
  readonly pid = 777;
  readonly supportsResize = true;
  readonly writes: string[] = [];
  readonly sizes: Array<{ cols: number; rows: number }> = [];
  private dataListener?: (value: string) => void;
  private exitListener?: (value: TerminalProcessExit) => void;

  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push({ cols, rows }); }
  kill(): void { this.exitListener?.({ exitCode: 0, signal: 'SIGTERM' }); }
  onData(listener: (data: string) => void): () => void { this.dataListener = listener; return () => { if (this.dataListener === listener) this.dataListener = undefined; }; }
  onExit(listener: (event: TerminalProcessExit) => void): () => void { this.exitListener = listener; return () => { if (this.exitListener === listener) this.exitListener = undefined; }; }
  onError(listener: (error: Error) => void): () => void { void listener; return () => undefined; }
  emitData(value: string): void { this.dataListener?.(value); }
}

class FakeInteractiveFactory implements InteractiveTerminalProcessFactory {
  process?: FakeInteractiveProcess;
  options?: TerminalProcessOptions;

  create(options: TerminalProcessOptions): InteractiveTerminalProcess {
    this.options = options;
    this.process = new FakeInteractiveProcess();
    return this.process;
  }
}

const project = {
  id: 'project-a',
  name: 'Test Project',
  rootPath: process.cwd(),
  createdAt: 1,
  updatedAt: 1,
};

test('orchestrates terminal execution and persists its final history', async () => {
  const storage = new MemoryStorage();
  const service = new TerminalService(storage as never, async () => [project]);
  await service.init();

  const events: string[] = [];
  const unsubscribe = service.subscribe((event) => {
    events.push(event.type);
  });

  const session = await service.start('project-a', process.platform === 'win32' ? 'echo terminal-service-test' : 'printf terminal-service-test');
  assert.equal(session.status, 'running');

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (await service.listSessions()).find((item) => item.id === session.id);
    if (current?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const history = await service.listHistory('project-a');
  assert.equal(history.length, 1);
  assert.match(history[0].output, /terminal-service-test/);
  assert.deepEqual(events, ['output', 'exit']);

  unsubscribe();
  service.dispose();
});

test('service exposes raw input and resize to the injected interactive transport', async () => {
  const storage = new MemoryStorage();
  const factory = new FakeInteractiveFactory();
  const service = new TerminalService(storage as never, async () => [project], factory);
  await service.init();

  const outputs: string[] = [];
  service.subscribe((event) => {
    if (event.type === 'output') outputs.push(event.event.text);
  });

  const session = await service.start('__global__', '__AUTO_CODEZ_SHELL__powershell');
  assert.equal(session.interactive, true);
  assert.equal(session.pty, true);
  assert.equal(factory.options?.shell, 'powershell');

  service.writeInput(session.id, 'dir\r');
  service.resize(session.id, 150, 45);
  factory.process?.emitData('terminal-output');

  assert.ok(factory.process);
  assert.equal(factory.process.writes.at(-1), 'dir\r');
  assert.deepEqual(factory.process.sizes, [{ cols: 150, rows: 45 }]);
  assert.deepEqual(outputs, ['terminal-output']);

  service.dispose();
});

test('isolates subscriber failures from terminal execution', async () => {
  const storage = new MemoryStorage();
  const service = new TerminalService(storage as never, async () => [project]);
  await service.init();
  service.subscribe(() => { throw new Error('observer failure'); });

  const session = await service.start('project-a', process.platform === 'win32' ? 'echo ok' : 'printf ok');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (await service.listSessions()).find((item) => item.id === session.id);
    if (current?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const [history] = await service.listHistory('project-a');
  assert.equal(history.exitCode, 0);
  service.dispose();
});
