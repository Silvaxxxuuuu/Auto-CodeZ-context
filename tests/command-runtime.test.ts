import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandRuntime } from '../src/agent/command-runtime';
import type { ProjectRecord } from '../src/ai/types';

async function createProject(): Promise<{ root: string; runtime: CommandRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-test-'));
  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Command Test',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    root,
    runtime: new CommandRuntime(async () => [project]),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

const nodeCommand = (expression: string): string => `node -e "${expression}"`;

test('command runtime rejects an empty command', async () => {
  const project = await createProject();
  try {
    await assert.rejects(project.runtime.run('project-test', '   '), /comando não pode estar vazio/);
  } finally {
    await project.cleanup();
  }
});

test('command runtime executes an arbitrary local command in the active workspace', async () => {
  const project = await createProject();
  try {
    const result = await project.runtime.run('project-test', nodeCommand("process.stdout.write('auto-codez-ok')"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /auto-codez-ok/);
    assert.match(result.command, /node -e/);
    assert.ok(result.startedAt > 0);
    assert.ok(result.finishedAt >= result.startedAt);
    assert.equal(result.durationMs, result.finishedAt - result.startedAt);
  } finally {
    await project.cleanup();
  }
});

test('command runtime uses the project directory as the working directory', async () => {
  const project = await createProject();
  try {
    const result = await project.runtime.run('project-test', nodeCommand("process.stdout.write(process.cwd())"));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), project.root);
  } finally {
    await project.cleanup();
  }
});

test('command runtime streams stdout and stderr without changing the final result', async () => {
  const project = await createProject();
  try {
    const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const result = await project.runtime.run('project-test', nodeCommand("process.stdout.write('out'); process.stderr.write('err')"), {
      onOutput: (event) => events.push(event),
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /out/);
    assert.match(result.stderr, /err/);
    assert.ok(events.some((event) => event.stream === 'stdout' && event.text.includes('out')));
    assert.ok(events.some((event) => event.stream === 'stderr' && event.text.includes('err')));
  } finally {
    await project.cleanup();
  }
});

test('command runtime isolates observer failures from command execution', async () => {
  const project = await createProject();
  try {
    const result = await project.runtime.run('project-test', nodeCommand("process.stdout.write('still-runs')"), {
      onOutput: () => { throw new Error('observer failed'); },
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /still-runs/);
  } finally {
    await project.cleanup();
  }
});
