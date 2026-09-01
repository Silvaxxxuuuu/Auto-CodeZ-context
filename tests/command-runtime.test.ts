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

test('command runtime rejects an unapproved package manager', async () => {
  const project = await createProject();
  try {
    await assert.rejects(project.runtime.run('project-test', 'cmd', 'test'), /Gerenciador de pacotes não permitido/);
  } finally {
    await project.cleanup();
  }
});

test('command runtime rejects an unapproved script', async () => {
  const project = await createProject();
  try {
    await assert.rejects(project.runtime.run('project-test', 'npm', 'start'), /Script não permitido pelo runtime/);
  } finally {
    await project.cleanup();
  }
});

test('command runtime requires the requested script to exist in package.json', async () => {
  const project = await createProject();
  try {
    await fs.writeFile(path.join(project.root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"' } }));
    await assert.rejects(project.runtime.run('project-test', 'npm', 'test'), /não existe no projeto/);
  } finally {
    await project.cleanup();
  }
});

test('command runtime executes an allowed npm script on Windows and Unix', async () => {
  const project = await createProject();
  try {
    const script = "node -e \"process.stdout.write('auto-codez-ok')\"";
    await fs.writeFile(path.join(project.root, 'package.json'), JSON.stringify({ scripts: { test: script } }));
    const result = await project.runtime.run('project-test', 'npm', 'test');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /auto-codez-ok/);
    assert.equal(result.command, 'npm run test');
  } finally {
    await project.cleanup();
  }
});

test('command runtime streams stdout and stderr without changing the final result', async () => {
  const project = await createProject();
  try {
    const script = "node -e \"process.stdout.write('out'); process.stderr.write('err')\"";
    await fs.writeFile(path.join(project.root, 'package.json'), JSON.stringify({ scripts: { test: script } }));
    const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const result = await project.runtime.run('project-test', 'npm', 'test', {
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
    const script = "node -e \"process.stdout.write('still-runs')\"";
    await fs.writeFile(path.join(project.root, 'package.json'), JSON.stringify({ scripts: { test: script } }));
    const result = await project.runtime.run('project-test', 'npm', 'test', {
      onOutput: () => { throw new Error('observer failed'); },
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /still-runs/);
  } finally {
    await project.cleanup();
  }
});
