import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShadowWorkspaceTransaction } from '../src/agent/shadow-workspace';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-restore-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
  }
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

test('restore recompõe overlay e baselines sem tocar no workspace real', async () => {
  const fx = await fixture({ 'a.txt': 'old-a', 'remove.txt': 'old-remove', 'rename.txt': 'old-rename' });
  try {
    let time = 100;
    const original = new ShadowWorkspaceTransaction(
      fx.workspace,
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      undefined,
      () => time++,
    );
    await original.writeFile('project-a', 'a.txt', 'new-a');
    await original.createFile('project-a', 'created.txt', 'created');
    await original.deleteFile('project-a', 'remove.txt');
    await original.renameFile('project-a', 'rename.txt', 'renamed.txt');
    await original.writeFile('project-a', 'renamed.txt', 'renamed-edited');
    const snapshot = original.snapshot();

    time = snapshot.updatedAt + 10;
    const restored = ShadowWorkspaceTransaction.restore(fx.workspace, snapshot, undefined, () => time++);

    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(await restored.readFile('project-a', 'a.txt'), 'new-a');
    assert.equal(await restored.readFile('project-a', 'created.txt'), 'created');
    assert.equal(await restored.exists('project-a', 'remove.txt'), false);
    assert.equal(await restored.exists('project-a', 'rename.txt'), false);
    assert.equal(await restored.readFile('project-a', 'renamed.txt'), 'renamed-edited');
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'old-a');
    assert.equal(await fx.workspace.exists('project-a', 'created.txt'), false);

    const committed = await restored.commit();
    assert.equal(committed.status, 'committed');
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'new-a');
    assert.equal(await fx.workspace.readFile('project-a', 'created.txt'), 'created');
    assert.equal(await fx.workspace.exists('project-a', 'remove.txt'), false);
    assert.equal(await fx.workspace.exists('project-a', 'rename.txt'), false);
    assert.equal(await fx.workspace.readFile('project-a', 'renamed.txt'), 'renamed-edited');
  } finally {
    await fx.cleanup();
  }
});

test('restore rejeita sequência de diff adulterada antes de criar transação utilizável', async () => {
  const fx = await fixture({ 'a.txt': 'old' });
  try {
    let time = 100;
    const original = new ShadowWorkspaceTransaction(
      fx.workspace,
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      undefined,
      () => time++,
    );
    await original.writeFile('project-a', 'a.txt', 'middle');
    await original.writeFile('project-a', 'a.txt', 'final');
    const snapshot = original.snapshot();
    snapshot.changes[1].before = 'tampered-before';

    assert.throws(
      () => ShadowWorkspaceTransaction.restore(fx.workspace, snapshot, undefined, () => 1000),
      /sequência inconsistente/i,
    );
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'old');
  } finally {
    await fx.cleanup();
  }
});

test('restore rejeita contagem de linhas adulterada e snapshots terminais', async () => {
  const fx = await fixture({ 'a.txt': 'one\n' });
  try {
    let time = 100;
    const original = new ShadowWorkspaceTransaction(
      fx.workspace,
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      undefined,
      () => time++,
    );
    await original.writeFile('project-a', 'a.txt', 'one\ntwo\n');
    const invalidCount = original.snapshot();
    invalidCount.changes[0].addedLines += 1;
    assert.throws(
      () => ShadowWorkspaceTransaction.restore(fx.workspace, invalidCount, undefined, () => 1000),
      /contagem de linhas inválida/i,
    );

    const terminal = original.snapshot();
    terminal.status = 'discarded';
    assert.throws(
      () => ShadowWorkspaceTransaction.restore(fx.workspace, terminal, undefined, () => 1000),
      /somente Shadow Workspaces ativos/i,
    );
  } finally {
    await fx.cleanup();
  }
});

test('mudança externa após snapshot continua bloqueando commit restaurado', async () => {
  const fx = await fixture({ 'a.txt': 'old-a', 'b.txt': 'old-b' });
  try {
    let time = 100;
    const original = new ShadowWorkspaceTransaction(
      fx.workspace,
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      undefined,
      () => time++,
    );
    await original.writeFile('project-a', 'a.txt', 'shadow-a');
    await original.writeFile('project-a', 'b.txt', 'shadow-b');
    const snapshot = original.snapshot();
    await fx.workspace.writeFile('project-a', 'a.txt', 'external-a');

    const restored = ShadowWorkspaceTransaction.restore(fx.workspace, snapshot, undefined, () => 1000);
    await assert.rejects(() => restored.commit(), /mudou fora do Shadow Workspace/i);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'external-a');
    assert.equal(await fx.workspace.readFile('project-a', 'b.txt'), 'old-b');
    assert.equal(restored.snapshot().status, 'active');
  } finally {
    await fx.cleanup();
  }
});

test('restore preserva timestamps e falha fechado se o relógio voltar no tempo', async () => {
  const fx = await fixture({ 'a.txt': 'old' });
  try {
    let time = 500;
    const original = new ShadowWorkspaceTransaction(
      fx.workspace,
      { chatId: 'chat-a', runId: 'run-a', projectId: 'project-a' },
      undefined,
      () => time++,
    );
    await original.writeFile('project-a', 'a.txt', 'new');
    const snapshot = original.snapshot();

    assert.throws(
      () => ShadowWorkspaceTransaction.restore(fx.workspace, snapshot, undefined, () => snapshot.updatedAt - 1),
      /relógio anterior ao snapshot/i,
    );

    const restored = ShadowWorkspaceTransaction.restore(fx.workspace, snapshot, undefined, () => snapshot.updatedAt + 1);
    assert.equal(restored.snapshot().createdAt, snapshot.createdAt);
    assert.equal(restored.snapshot().updatedAt, snapshot.updatedAt);
  } finally {
    await fx.cleanup();
  }
});
