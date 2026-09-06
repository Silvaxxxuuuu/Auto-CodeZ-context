import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandRuntime, SYSTEM_PROJECT_ID } from '../src/agent/command-runtime';
import { runWithAbortSignal } from '../src/ai/request-cancellation';
import type { ProjectRecord } from '../src/ai/types';

async function createProject(parentEnvironment: NodeJS.ProcessEnv = process.env): Promise<{ root: string; runtime: CommandRuntime; cleanup: () => Promise<void> }> {
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
    runtime: new CommandRuntime(async () => [project], parentEnvironment),
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
    assert.equal(result.stdout.trim(), await fs.realpath(project.root));
  } finally {
    await project.cleanup();
  }
});

test('command runtime filters sensitive and startup-injection environment without dropping normal variables', async () => {
  const project = await createProject({
    ...process.env,
    AUTO_CODEZ_TEST_API_KEY: 'api-secret',
    AUTO_CODEZ_TEST_TOKEN: 'token-secret',
    AUTO_CODEZ_TEST_SAFE_FLAG: 'safe-value',
    SSH_AUTH_SOCK: 'secret-socket',
    NPM_CONFIG_USERCONFIG: 'secret-config',
    NPM_CONFIG_GLOBALCONFIG: 'global-secret-config',
    NODE_OPTIONS: '--require auto-codez-should-not-load',
    BASH_ENV: 'outside-shell-init',
    LD_PRELOAD: 'outside-preload',
    GIT_CONFIG_GLOBAL: 'outside-gitconfig',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: 'manager',
  });
  try {
    const expression = "process.stdout.write(JSON.stringify({apiKey:process.env.AUTO_CODEZ_TEST_API_KEY??null,token:process.env.AUTO_CODEZ_TEST_TOKEN??null,safe:process.env.AUTO_CODEZ_TEST_SAFE_FLAG??null,ssh:process.env.SSH_AUTH_SOCK??null,npmConfig:process.env.NPM_CONFIG_USERCONFIG??null,npmGlobal:process.env.NPM_CONFIG_GLOBALCONFIG??null,nodeOptions:process.env.NODE_OPTIONS??null,bashEnv:process.env.BASH_ENV??null,ldPreload:process.env.LD_PRELOAD??null,gitGlobal:process.env.GIT_CONFIG_GLOBAL??null,gitCount:process.env.GIT_CONFIG_COUNT??null,gitKey:process.env.GIT_CONFIG_KEY_0??null,gitValue:process.env.GIT_CONFIG_VALUE_0??null}))";
    const result = await project.runtime.run('project-test', nodeCommand(expression));
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      apiKey: null,
      token: null,
      safe: 'safe-value',
      ssh: null,
      npmConfig: null,
      npmGlobal: null,
      nodeOptions: null,
      bashEnv: null,
      ldPreload: null,
      gitGlobal: null,
      gitCount: null,
      gitKey: null,
      gitValue: null,
    });
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

test('command runtime aborts a running process tree', async () => {
  const project = await createProject();
  const controller = new AbortController();
  try {
    const startedAt = Date.now();
    const running = project.runtime.run('project-test', nodeCommand("setTimeout(() => process.stdout.write('late'), 30000)"), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await project.cleanup();
  }
});

test('command runtime inherits cancellation from the active execution context', async () => {
  const project = await createProject();
  const controller = new AbortController();
  try {
    const startedAt = Date.now();
    const running = runWithAbortSignal(controller.signal, () => project.runtime.run('project-test', nodeCommand("setTimeout(() => process.stdout.write('late'), 30000)")));
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await project.cleanup();
  }
});

test('command runtime executes a system command without a project context', async () => {
  const runtime = new CommandRuntime(async () => []);
  const result = await runtime.run(SYSTEM_PROJECT_ID, nodeCommand("process.stdout.write('system-ok')"));

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'system-ok');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
});
