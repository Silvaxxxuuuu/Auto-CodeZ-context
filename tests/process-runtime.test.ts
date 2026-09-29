import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { ProcessRuntime } from '../src/agent/process-runtime';

async function fixture(parentEnvironment: NodeJS.ProcessEnv = process.env) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-process-runtime-'));
  const project: ProjectRecord = {
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  let id = 0;
  const runtime = new ProcessRuntime(async () => [project], parentEnvironment, () => `process-${++id}`);
  return {
    root,
    runtime,
    cleanup: async () => {
      await runtime.stopAll().catch(() => []);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const nodeCommand = (expression: string) => `node -e "${expression}"`;

test('ProcessRuntime starts a persistent process and exposes it through list/get', async () => {
  const f = await fixture();
  try {
    const started = await f.runtime.start('project-a', nodeCommand("setTimeout(() => {}, 30000)"));
    assert.equal(started.id, 'process-1');
    assert.equal(started.status, 'running');
    assert.ok(started.pid);

    assert.equal(f.runtime.get(started.id).status, 'running');
    assert.deepEqual(f.runtime.list('project-a').map((item) => item.id), ['process-1']);

    const stopped = await f.runtime.stop(started.id);
    assert.equal(stopped.status, 'stopped');
    assert.ok(stopped.finishedAt);
  } finally {
    await f.cleanup();
  }
});

test('ProcessRuntime streams stdout/stderr into a cursor-based incremental buffer', async () => {
  const f = await fixture();
  try {
    const started = await f.runtime.start(
      'project-a',
      nodeCommand("process.stdout.write('one'); process.stderr.write('err'); setTimeout(() => process.stdout.write('two'), 40); setTimeout(() => process.exit(0), 90)"),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    const first = f.runtime.readOutput(started.id);
    assert.ok(first.events.some((event) => event.stream === 'stdout' && event.text.includes('one')));
    assert.ok(first.events.some((event) => event.stream === 'stderr' && event.text.includes('err')));

    const finished = await f.runtime.wait(started.id, 2000);
    assert.equal(finished.status, 'exited');
    assert.equal(finished.exitCode, 0);

    const second = f.runtime.readOutput(started.id, first.nextSequence);
    assert.ok(second.events.some((event) => event.stream === 'stdout' && event.text.includes('two')));
    assert.equal(second.events.every((event) => event.sequence > first.nextSequence), true);
  } finally {
    await f.cleanup();
  }
});

test('ProcessRuntime wait can poll without killing a still-running process', async () => {
  const f = await fixture();
  try {
    const started = await f.runtime.start('project-a', nodeCommand("setTimeout(() => process.exit(0), 500)"));
    const polled = await f.runtime.wait(started.id, 20);
    assert.equal(polled.status, 'running');

    const finished = await f.runtime.wait(started.id, 2000);
    assert.equal(finished.status, 'exited');
  } finally {
    await f.cleanup();
  }
});

test('ProcessRuntime records non-zero exits as failed without throwing away process state', async () => {
  const f = await fixture();
  try {
    const started = await f.runtime.start('project-a', nodeCommand("process.stderr.write('bad'); process.exit(7)"));
    const finished = await f.runtime.wait(started.id, 2000);

    assert.equal(finished.status, 'failed');
    assert.equal(finished.exitCode, 7);
    assert.match(f.runtime.readOutput(started.id).events.map((event) => event.text).join(''), /bad/);
  } finally {
    await f.cleanup();
  }
});

test('ProcessRuntime executes from project cwd and filters sensitive environment like CommandRuntime', async () => {
  const f = await fixture({
    ...process.env,
    PROCESS_TEST_SAFE: 'visible',
    PROCESS_TEST_TOKEN: 'secret',
    NODE_OPTIONS: '--require should-not-load',
  });
  try {
    const expression = "process.stdout.write(JSON.stringify({cwd:process.cwd(),safe:process.env.PROCESS_TEST_SAFE??null,token:process.env.PROCESS_TEST_TOKEN??null,nodeOptions:process.env.NODE_OPTIONS??null}))";
    const started = await f.runtime.start('project-a', nodeCommand(expression));
    const finished = await f.runtime.wait(started.id, 2000);
    assert.equal(finished.status, 'exited');

    const text = f.runtime.readOutput(started.id).events.map((event) => event.text).join('');
    const parsed = JSON.parse(text);
    assert.equal(parsed.cwd, await fs.realpath(f.root));
    assert.equal(parsed.safe, 'visible');
    assert.equal(parsed.token, null);
    assert.equal(parsed.nodeOptions, null);
  } finally {
    await f.cleanup();
  }
});

test('ProcessRuntime stop is idempotent after completion and remove refuses running processes', async () => {
  const f = await fixture();
  try {
    const running = await f.runtime.start('project-a', nodeCommand("setTimeout(() => {}, 30000)"));
    assert.throws(() => f.runtime.remove(running.id), /ainda em execução/i);
    const stopped = await f.runtime.stop(running.id);
    assert.equal((await f.runtime.stop(running.id)).status, stopped.status);
    assert.equal(f.runtime.remove(running.id), true);

    const quick = await f.runtime.start('project-a', nodeCommand("process.exit(0)"));
    await f.runtime.wait(quick.id, 2000);
    assert.equal(f.runtime.remove(quick.id), true);
    assert.throws(() => f.runtime.get(quick.id), /não encontrado/i);
  } finally {
    await f.cleanup();
  }
});

test('ProcessRuntime rejects invalid commands, project ids, cursors and duplicate ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-process-runtime-invalid-'));
  try {
    const project: ProjectRecord = { id: 'project-a', name: 'A', rootPath: root, createdAt: 1, updatedAt: 1 };
    const runtime = new ProcessRuntime(async () => [project], process.env, () => 'same-id');

    await assert.rejects(() => runtime.start('project-a', '   '), /não pode estar vazio/i);
    await assert.rejects(() => runtime.start('missing', 'node -v'), /Projeto não encontrado/);
    assert.throws(() => runtime.readOutput('missing', 0), /não encontrado/);

    const started = await runtime.start('project-a', nodeCommand("setTimeout(() => {}, 30000)"));
    assert.throws(() => runtime.readOutput(started.id, -1), /inteiro >= 0/);
    await assert.rejects(() => runtime.start('project-a', nodeCommand("process.exit(0)")), /duplicado/i);
    await runtime.stop(started.id);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('ProcessRuntime wait ignores output activity and resolves only on exit or timeout', async () => {
  const f = await fixture();
  try {
    const started = await f.runtime.start(
      'project-a',
      nodeCommand("process.stdout.write('early'); setTimeout(() => process.exit(0), 220)"),
    );

    const before = Date.now();
    const finished = await f.runtime.wait(started.id, 2000);
    const elapsed = Date.now() - before;

    assert.equal(finished.status, 'exited');
    assert.ok(elapsed >= 120);
    assert.match(f.runtime.readOutput(started.id).events.map((event) => event.text).join(''), /early/);
  } finally {
    await f.cleanup();
  }
});
