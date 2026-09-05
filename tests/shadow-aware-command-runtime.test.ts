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

test('sem contexto de execução usa o workspace real', async () => {
  const fx = await fixture();
  try {
    const result = await fx.runtime.run('project-a', readCommand);
    assert.match(result.stdout, /base/);
  } finally {
    await fx.cleanup();
  }
});

test('contexto sem shadow ativo continua usando o workspace real', async () => {
  const fx = await fixture();
  try {
    const result = await runWithExecutionWorkspaceContext(
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      () => fx.runtime.run('project-a', readCommand),
    );
    assert.match(result.stdout, /base/);
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

test('contexto de outro projeto não reutiliza shadow incorreto', async () => {
  const fx = await fixture();
  try {
    fx.shadows.begin('chat-a', 'run-a', 'project-a');
    const result = await runWithExecutionWorkspaceContext(
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-b' },
      () => fx.runtime.run('project-a', readCommand),
    );
    assert.match(result.stdout, /base/);
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
