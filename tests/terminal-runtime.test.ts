import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TerminalRuntime, type TerminalOutputEvent, type TerminalExitEvent } from '../src/agent/terminal-runtime';
import type { ProjectRecord } from '../src/ai/types';

async function createProject(): Promise<{ root: string; runtime: TerminalRuntime; events: Array<TerminalOutputEvent | TerminalExitEvent>; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-terminal-test-'));
  const project: ProjectRecord = { id: 'terminal-project', name: 'Terminal Test', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const events: Array<TerminalOutputEvent | TerminalExitEvent> = [];
  return {
    root,
    events,
    runtime: new TerminalRuntime(async () => [project], (event) => events.push(event)),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
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
    assert.equal(fixture.runtime.getOutput(session.id), 'terminal-ok');
    assert.ok(fixture.events.some((event) => 'stream' in event && event.text.includes('terminal-ok')));
    assert.ok(fixture.events.some((event) => 'exitCode' in event && event.exitCode === 0));
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
