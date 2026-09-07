import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { SYSTEM_PROJECT_ID } from '../src/agent/command-runtime';
import { DiffRuntime } from '../src/agent/diff-runtime';
import { CommandSandboxMaterializer, CommandSandboxRuntime } from '../src/agent/command-sandbox';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-sandbox-test-'));
  await write(root, 'a.txt', 'base');
  await write(root, '.env', 'SECRET=top-secret');
  await write(root, '.env.example', 'SECRET=replace-me');
  await write(root, '.npmrc', '//registry.npmjs.org/:_authToken=secret');
  await write(root, '.ssh/id_ed25519', 'private-key');
  await write(root, '.git/config', 'git-private');
  await write(root, 'dist/stale.txt', 'stale');
  await write(root, 'node_modules/example/index.js', 'module.exports = 42;');
  const projects = async (): Promise<ProjectRecord[]> => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }];
  const workspace = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(workspace);
  return {
    root,
    projects,
    workspace,
    shadows,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('materialização aplica o estado final do shadow sem copiar Git, outputs ou arquivos sensíveis', async () => {
  const fx = await fixture();
  const diffs = new DiffRuntime();
  try {
    const materializer = new CommandSandboxMaterializer(fx.projects);
    const sandbox = await materializer.materialize('project-a', [
      diffs.create('a.txt', 'modified', 'base', 'shadow'),
      diffs.create('created.txt', 'created', '', 'created'),
    ]);
    try {
      assert.equal(await fs.readFile(path.join(sandbox.rootPath, 'a.txt'), 'utf8'), 'shadow');
      assert.equal(await fs.readFile(path.join(sandbox.rootPath, 'created.txt'), 'utf8'), 'created');
      assert.equal(await fs.readFile(path.join(sandbox.rootPath, '.env.example'), 'utf8'), 'SECRET=replace-me');
      assert.equal(await fs.readFile(path.join(sandbox.rootPath, 'node_modules/example/index.js'), 'utf8'), 'module.exports = 42;');
      await assert.rejects(fs.access(path.join(sandbox.rootPath, '.env')));
      await assert.rejects(fs.access(path.join(sandbox.rootPath, '.npmrc')));
      await assert.rejects(fs.access(path.join(sandbox.rootPath, '.ssh')));
      await assert.rejects(fs.access(path.join(sandbox.rootPath, '.git')));
      await assert.rejects(fs.access(path.join(sandbox.rootPath, 'dist')));

      await fs.writeFile(path.join(sandbox.rootPath, 'a.txt'), 'sandbox-only', 'utf8');
      await fs.writeFile(path.join(sandbox.rootPath, 'node_modules/example/index.js'), 'sandbox-module', 'utf8');
      assert.equal(await fs.readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'base');
      assert.equal(await fs.readFile(path.join(fx.root, 'node_modules/example/index.js'), 'utf8'), 'module.exports = 42;');
    } finally {
      const temporaryRoot = path.dirname(sandbox.rootPath);
      await sandbox.cleanup();
      await assert.rejects(fs.access(temporaryRoot));
    }
  } finally {
    await fx.cleanup();
  }
});

test('materialização não segue alias interno para conteúdo sensível', async (t) => {
  const fx = await fixture();
  try {
    const link = path.join(fx.root, 'safe-credentials');
    try {
      await fs.symlink(path.join(fx.root, '.ssh'), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip(`Links não suportados neste runner: ${code}`);
        return;
      }
      throw error;
    }

    const materializer = new CommandSandboxMaterializer(fx.projects);
    const sandbox = await materializer.materialize('project-a', []);
    try {
      await assert.rejects(fs.access(path.join(sandbox.rootPath, 'safe-credentials')));
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

test('materialização rejeita shadow que tente reintroduzir caminho sensível', async () => {
  const fx = await fixture();
  const diffs = new DiffRuntime();
  try {
    const materializer = new CommandSandboxMaterializer(fx.projects);
    await assert.rejects(
      () => materializer.materialize('project-a', [
        diffs.create('.env', 'modified', 'SECRET=top-secret', 'SECRET=changed'),
      ]),
      /caminho sensível/i,
    );
  } finally {
    await fx.cleanup();
  }
});

test('materialização suporta workspace de sistema usando raiz controlada', async () => {
  const fx = await fixture();
  const systemRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-system-command-sandbox-test-'));
  try {
    await write(systemRoot, 'desktop-file.txt', 'desktop-base');
    await write(systemRoot, '.env', 'SECRET=desktop-secret');
    const materializer = new CommandSandboxMaterializer(fx.projects, () => systemRoot);
    const sandbox = await materializer.materialize(SYSTEM_PROJECT_ID, []);
    try {
      assert.equal(await fs.readFile(path.join(sandbox.rootPath, 'desktop-file.txt'), 'utf8'), 'desktop-base');
      await assert.rejects(fs.access(path.join(sandbox.rootPath, '.env')));
      await fs.writeFile(path.join(sandbox.rootPath, 'desktop-file.txt'), 'sandbox-only', 'utf8');
      assert.equal(await fs.readFile(path.join(systemRoot, 'desktop-file.txt'), 'utf8'), 'desktop-base');
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await Promise.all([
      fx.cleanup(),
      fs.rm(systemRoot, { recursive: true, force: true }),
    ]);
  }
});

test('command sandbox executa contra o overlay e descarta mutações feitas pelo comando', async () => {
  const fx = await fixture();
  try {
    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'shadow-value');
    const runtime = new CommandSandboxRuntime(fx.projects, fx.shadows);

    const result = await runtime.run(
      'chat-a',
      'run-a',
      'project-a',
      'node -e "const fs=require(\'fs\'); console.log(fs.readFileSync(\'a.txt\',\'utf8\')); fs.writeFileSync(\'a.txt\',\'command-only\')"',
    );

    assert.match(result.stdout, /shadow-value/);
    assert.equal(await fs.readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'base');
    assert.equal(await shadow.readFile('project-a', 'a.txt'), 'shadow-value');
  } finally {
    await fx.cleanup();
  }
});

test('command sandbox consegue resolver dependência copiada sem usar o node_modules real', async () => {
  const fx = await fixture();
  try {
    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'shadow');
    const runtime = new CommandSandboxRuntime(fx.projects, fx.shadows);

    const result = await runtime.run(
      'chat-a',
      'run-a',
      'project-a',
      'node -e "console.log(require(\'example\'))"',
    );

    assert.match(result.stdout, /42/);
  } finally {
    await fx.cleanup();
  }
});

test('command sandbox rejeita run ausente e projeto divergente', async () => {
  const fx = await fixture();
  try {
    const runtime = new CommandSandboxRuntime(fx.projects, fx.shadows);
    await assert.rejects(
      () => runtime.run('chat-a', 'missing', 'project-a', 'node -v'),
      /Shadow Workspace ativo não encontrado/i,
    );

    fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await assert.rejects(
      () => runtime.run('chat-a', 'run-a', 'project-b', 'node -v'),
      /outro projeto/i,
    );
  } finally {
    await fx.cleanup();
  }
});
