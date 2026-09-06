import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { CommandSandboxRuntime } from '../src/agent/command-sandbox';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-home-project-'));
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-real-home-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
  await fs.writeFile(path.join(fakeHome, '.npmrc'), '//registry.npmjs.org/:_authToken=should-not-leak', 'utf8');

  const projects = async (): Promise<ProjectRecord[]> => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }];
  const workspace = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(workspace);
  const parentEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    TEMP: path.join(fakeHome, 'Temp'),
    TMP: path.join(fakeHome, 'Temp'),
    TMPDIR: path.join(fakeHome, 'Temp'),
  };

  return {
    root,
    fakeHome,
    projects,
    shadows,
    parentEnvironment,
    cleanup: async () => {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(fakeHome, { recursive: true, force: true }),
      ]);
    },
  };
}

test('command sandbox isola home, config, temp e configuração Git do ambiente real do usuário', async () => {
  const fx = await fixture();
  try {
    fx.shadows.begin('chat-a', 'run-a', 'project-a');
    const runtime = new CommandSandboxRuntime(fx.projects, fx.shadows, undefined, fx.parentEnvironment);
    const command = `node -e "const os=require('os'); const fs=require('fs'); const path=require('path'); const home=os.homedir(); process.stdout.write(JSON.stringify({cwd:process.cwd(),home,envHome:process.env.HOME??null,profile:process.env.USERPROFILE??null,appData:process.env.APPDATA??null,localAppData:process.env.LOCALAPPDATA??null,temp:process.env.TEMP??null,tmp:process.env.TMP??null,tmpdir:process.env.TMPDIR??null,osTmp:os.tmpdir(),npmrc:fs.existsSync(path.join(home,'.npmrc')),gitPrompt:process.env.GIT_TERMINAL_PROMPT??null,gcm:process.env.GCM_INTERACTIVE??null,gitNoSystem:process.env.GIT_CONFIG_NOSYSTEM??null,gitAttrNoSystem:process.env.GIT_ATTR_NOSYSTEM??null,gitCeiling:process.env.GIT_CEILING_DIRECTORIES??null}))"`;

    const result = await runtime.run('chat-a', 'run-a', 'project-a', command);
    const values = JSON.parse(result.stdout.trim()) as Record<string, string | boolean | null>;
    const home = String(values.home);
    const temporaryRoot = path.dirname(home);

    assert.notEqual(home, fx.fakeHome);
    assert.match(path.basename(temporaryRoot), /^auto-codez-command-sandbox-/);
    assert.equal(values.envHome, home);
    assert.equal(values.profile, home);
    assert.equal(values.npmrc, false);
    assert.equal(values.gitPrompt, '0');
    assert.equal(values.gcm, 'Never');
    assert.equal(values.gitNoSystem, '1');
    assert.equal(values.gitAttrNoSystem, '1');
    assert.equal(values.gitCeiling, values.cwd);

    for (const key of ['appData', 'localAppData'] as const) {
      assert.ok(String(values[key]).startsWith(`${home}${path.sep}`));
    }
    for (const key of ['temp', 'tmp', 'tmpdir', 'osTmp'] as const) {
      assert.equal(path.dirname(String(values[key])), temporaryRoot);
    }

    await assert.rejects(fs.access(temporaryRoot));
  } finally {
    await fx.cleanup();
  }
});
