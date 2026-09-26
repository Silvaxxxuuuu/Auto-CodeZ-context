import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-runtime-'));
  await writeFile(path.join(root, 'a.txt'), 'old', 'utf8');
  const workspace = new WorkspaceRuntime(async () => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }]);
  return {
    workspace,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

test('runtime reutiliza a mesma transação para chat run e projeto', async () => {
  const fx = await fixture();
  try {
    let time = 100;
    const runtime = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    const first = runtime.begin('chat-a', 'run-a', 'project-a');
    const second = runtime.begin('chat-a', 'run-a', 'project-a');

    assert.equal(first, second);
    assert.equal(runtime.list().length, 1);
    assert.throws(() => runtime.begin('chat-a', 'run-a', 'project-b'), /outro projeto/i);
  } finally {
    await fx.cleanup();
  }
});

test('workspace gerenciado notifica snapshots após mutações bem-sucedidas', async () => {
  const fx = await fixture();
  try {
    let time = 100;
    const runtime = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    const observations: number[] = [];
    runtime.subscribe((snapshots) => observations.push(snapshots[0]?.changes.length ?? 0));
    const workspace = runtime.workspace('chat-a', 'run-a', 'project-a');

    await workspace.writeFile('project-a', 'a.txt', 'new');
    await workspace.createFile('project-a', 'b.txt', 'created');

    assert.deepEqual(observations, [0, 1, 2]);
    assert.equal(runtime.get('chat-a', 'run-a')?.changes.length, 2);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'old');
    assert.equal(await fx.workspace.exists('project-a', 'b.txt'), false);
  } finally {
    await fx.cleanup();
  }
});

test('commit publica alterações e remove somente a transação concluída', async () => {
  const fx = await fixture();
  try {
    let time = 100;
    const runtime = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    const first = runtime.workspace('chat-a', 'run-a', 'project-a');
    runtime.begin('chat-b', 'run-b', 'project-a');
    await first.writeFile('project-a', 'a.txt', 'new');

    const committed = await runtime.commit('chat-a', 'run-a');

    assert.equal(committed.status, 'committed');
    assert.equal(runtime.get('chat-a', 'run-a'), undefined);
    assert.ok(runtime.get('chat-b', 'run-b'));
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'new');
  } finally {
    await fx.cleanup();
  }
});

test('discard remove transação sem publicar alterações', async () => {
  const fx = await fixture();
  try {
    let time = 100;
    const runtime = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    const workspace = runtime.workspace('chat-a', 'run-a', 'project-a');
    await workspace.writeFile('project-a', 'a.txt', 'shadow');

    const discarded = runtime.discard('chat-a', 'run-a');

    assert.equal(discarded.status, 'discarded');
    assert.equal(runtime.list().length, 0);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'old');
  } finally {
    await fx.cleanup();
  }
});

test('restore é atômico e preserva múltiplas execuções independentes', async () => {
  const fx = await fixture();
  try {
    let time = 100;
    const source = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    await source.workspace('chat-a', 'run-a', 'project-a').writeFile('project-a', 'a.txt', 'a-shadow');
    await source.workspace('chat-b', 'run-b', 'project-a').createFile('project-a', 'b.txt', 'b-shadow');
    const snapshots = source.list();

    time = 1000;
    const restored = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    restored.restore(snapshots);
    assert.equal(restored.list().length, 2);
    assert.equal(await restored.workspace('chat-a', 'run-a', 'project-a').readFile('project-a', 'a.txt'), 'a-shadow');
    assert.equal(await restored.workspace('chat-b', 'run-b', 'project-a').readFile('project-a', 'b.txt'), 'b-shadow');

    const before = restored.list();
    assert.throws(() => restored.restore([snapshots[0], snapshots[0]]), /duplicado/i);
    assert.deepEqual(restored.list(), before);
  } finally {
    await fx.cleanup();
  }
});

test('removeChat limpa somente transações do chat solicitado', async () => {
  const fx = await fixture();
  try {
    let time = 100;
    const runtime = new ExecutionShadowWorkspaceRuntime(fx.workspace, () => time++);
    runtime.begin('chat-a', 'run-a1', 'project-a');
    runtime.begin('chat-a', 'run-a2', 'project-a');
    runtime.begin('chat-b', 'run-b', 'project-a');

    assert.equal(runtime.removeChat('chat-a'), 2);
    assert.equal(runtime.list().length, 1);
    assert.equal(runtime.list()[0].chatId, 'chat-b');
  } finally {
    await fx.cleanup();
  }
});
