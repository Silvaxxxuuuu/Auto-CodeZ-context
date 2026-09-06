import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { runWithExecutionWorkspaceContext } from '../src/agent/execution-workspace-context';
import { ShadowAwareCommandRuntime } from '../src/agent/shadow-aware-command-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-aware-command-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
  const projects = async (): Promise<ProjectRecord[]> => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }];
  const workspace = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(workspace);
  const runtime = new ShadowAwareCommandRuntime(projects, shadows);
  return {
    root,
    shadows,
    runtime,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

const readCommand = 'node -e "console.log(require(\'fs\').readFileSync(\'a.txt\',\'utf8\'))"';
const mutateCommand = 'node -e "require(\'fs\').writeFileSync(\'a.txt\',\'command-only\')"';

test('sem contexto de execução usa o workspace real', async () => {
  const fx = await fixture();
  try {
    const result = await fx.runtime.run('project-a', readCommand);
    assert.match(result.stdout, /base/);
    assert.equal(fx.shadows.list().length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('primeiro comando de uma execução cria shadow vazio e não toca no projeto real', async () => {
  const fx = await fixture();
  try {
    await runWithExecutionWorkspaceContext(
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      () => fx.runtime.run('project-a', mutateCommand),
    );

    assert.equal(await fs.readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'base');
    const shadow = fx.shadows.get('chat-a', 'run-a');
    assert.ok(shadow);
    assert.equal(shadow.changes.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('shadow ativo executa comando contra a visão isolada', async () => {
  const fx = await fixture();
  try {
    const shadow = fx.shadows.begin('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'shadow');

    const result = await runWithExecutionWorkspaceContext(
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      () => fx.runtime.run('project-a', readCommand),
    );

    assert.match(result.stdout, /shadow/);
    assert.equal(await fs.readFile(path.join(fx.root, 'a.txt'), 'utf8'), 'base');
  } finally {
    await fx.cleanup();
  }
});

test('contexto de outro projeto falha fechado em vez de tocar no workspace real', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => runWithExecutionWorkspaceContext(
        { chatId: 'chat-a', runId: 'run-a', projectId: 'project-b' },
        () => fx.runtime.run('project-a', readCommand),
      ),
      /outro projeto/i,
    );
    assert.equal(fx.shadows.list().length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('workspace de sistema com shadow ativo falha fechado', async () => {
  const fx = await fixture();
  try {
    fx.shadows.begin('chat-system', 'run-system', '__system__');
    await assert.rejects(
      () => runWithExecutionWorkspaceContext(
        { chatId: 'chat-system', runId: 'run-system', projectId: '__system__' },
        () => fx.runtime.run('__system__', 'node -v'),
      ),
      /workspace de sistema/i,
    );
  } finally {
    await fx.cleanup();
  }
});
