import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NodePtyInteractiveTerminalProcessFactory,
  loadNodePtyInteractiveTerminalProcessFactory,
  type NodePtyModule,
} from '../src/agent/terminal-node-pty';

type Listener<T> = (value: T) => void;

class DisposableSet<T> {
  private readonly listeners = new Set<Listener<T>>();
  add(listener: Listener<T>) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

function createModule() {
  const data = new DisposableSet<string>();
  const exits = new DisposableSet<{ exitCode: number; signal?: number }>();
  const writes: string[] = [];
  const sizes: Array<{ cols: number; rows: number }> = [];
  let killed = false;
  let captured: { file: string; args: string[]; options: Record<string, unknown> } | undefined;
  const module: NodePtyModule = {
    spawn(file, args, options) {
      captured = { file, args, options };
      return {
        pid: 999,
        write(value) { writes.push(value); },
        resize(cols, rows) { sizes.push({ cols, rows }); },
        kill() { killed = true; },
        onData(listener) { return data.add(listener); },
        onExit(listener) { return exits.add(listener); },
      };
    },
  };
  return { module, data, exits, writes, sizes, killed: () => killed, captured: () => captured };
}

test('node-pty adapter maps shell, environment, raw input, resize and exit events', () => {
  const fixture = createModule();
  const factory = new NodePtyInteractiveTerminalProcessFactory(fixture.module);
  const processHandle = factory.create({
    shell: 'powershell',
    cwd: 'C:\\Workspace',
    cols: 132,
    rows: 41,
    env: { PATH: 'C:\\bin', UNUSED: undefined },
  });

  const captured = fixture.captured();
  assert.ok(captured);
  assert.match(captured.file.toLowerCase(), /powershell\.exe$/);
  assert.deepEqual(captured.args, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']);
  assert.equal(captured.options.cwd, 'C:\\Workspace');
  assert.equal(captured.options.cols, 132);
  assert.equal(captured.options.rows, 41);
  assert.equal(captured.options.name, 'xterm-256color');
  assert.equal(captured.options.useConpty, process.platform === 'win32');
  assert.deepEqual(captured.options.env, {
    PATH: 'C:\\bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  });

  assert.equal(processHandle.pid, 999);
  assert.equal(processHandle.supportsResize, true);
  processHandle.write('npm start\r');
  processHandle.resize(160, 50);
  processHandle.kill();
  assert.deepEqual(fixture.writes, ['npm start\r']);
  assert.deepEqual(fixture.sizes, [{ cols: 160, rows: 50 }]);
  assert.equal(fixture.killed(), true);

  const output: string[] = [];
  const exitEvents: Array<{ exitCode: number; signal?: string }> = [];
  const unsubscribeData = processHandle.onData((value) => output.push(value));
  const unsubscribeExit = processHandle.onExit((event) => exitEvents.push(event));
  fixture.data.emit('\u001b[32mok\u001b[0m');
  fixture.exits.emit({ exitCode: 0, signal: 2 });
  assert.deepEqual(output, ['\u001b[32mok\u001b[0m']);
  assert.deepEqual(exitEvents, [{ exitCode: 0, signal: '2' }]);
  unsubscribeData();
  unsubscribeExit();
  fixture.data.emit('ignored');
  fixture.exits.emit({ exitCode: 1 });
  assert.equal(output.length, 1);
  assert.equal(exitEvents.length, 1);
});

test('optional loader accepts direct and CommonJS-default node-pty module shapes', async () => {
  const direct = createModule();
  const directFactory = await loadNodePtyInteractiveTerminalProcessFactory(async (specifier) => {
    assert.equal(specifier, 'node-pty');
    return direct.module;
  });
  assert.ok(directFactory);
  assert.equal(directFactory.create({ shell: 'cmd', cwd: 'C:\\', cols: 80, rows: 24, env: {} }).supportsResize, true);

  const nested = createModule();
  const nestedFactory = await loadNodePtyInteractiveTerminalProcessFactory(async () => ({ default: nested.module }));
  assert.ok(nestedFactory);
  assert.equal(nestedFactory.create({ shell: 'cmd', cwd: 'C:\\', cols: 80, rows: 24, env: {} }).supportsResize, true);
});

test('optional loader falls back cleanly when node-pty is missing or malformed', async () => {
  assert.equal(await loadNodePtyInteractiveTerminalProcessFactory(async () => { throw new Error('MODULE_NOT_FOUND'); }), undefined);
  assert.equal(await loadNodePtyInteractiveTerminalProcessFactory(async () => ({ default: {} })), undefined);
});

test('installed node-pty module is loadable by the runtime adapter', async () => {
  const factory = await loadNodePtyInteractiveTerminalProcessFactory();
  assert.ok(factory);
});
