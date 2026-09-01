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

test('terminal runtime starts a project-scoped process and streams output', async () => {
  const fixture = await createProject();
  try {
    const session = await fixture.runtime.start('terminal-project', nodeCommand("process.stdout.write('terminal-ok')"));
    const deadline = Date.now() + 5000;
    let current = session;
    while (current.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = (await fixture.runtime.list()).find((item) => item.id === session.id) ?? current;
    }
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

test('terminal runtime kills a running process', async () => {
  const fixture = await createProject();
  try {
    const command = process.platform === 'win32' ? 'ping 127.0.0.1 -n 30 > nul' : 'sleep 30';
    const session = await fixture.runtime.start('terminal-project', command);
    fixture.runtime.kill(session.id);
    const deadline = Date.now() + 5000;
    let current = session;
    while (current.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = (await fixture.runtime.list()).find((item) => item.id === session.id) ?? current;
    }
    assert.notEqual(current.status, 'running');
  } finally {
    fixture.runtime.dispose();
    await fixture.cleanup();
  }
});
