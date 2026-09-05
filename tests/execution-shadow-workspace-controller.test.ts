import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionShadowWorkspaceController, type ShadowCommitCheckpointRecord } from '../src/execution-shadow-workspace-controller';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-controller-'));
  await writeFile(path.join(root, 'a.txt'), 'old\n', 'utf8');
  const workspace = new WorkspaceRuntime(async () => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }]);
  let time = 100;
  const runtime = new ExecutionShadowWorkspaceRuntime(workspace, () => time++);
  return {
    workspace,
    runtime,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

test('commitIfPresent sem shadow é no-op', async () => {
  const fx = await fixture();
  try {
    const controller = new ExecutionShadowWorkspaceController(fx.runtime);
    assert.deepEqual(await controller.commitIfPresent('chat-a', 'run-a'), {
      committed: false,
      publicationChanges: [],
    });
  } finally {
    await fx.cleanup();
  }
});

test('commit publica estado líquido e registra um único checkpoint sem paths duplicados', async () => {
  const fx = await fixture();
  try {
    const shadow = fx.runtime.workspace('chat-a', 'run-a', 'project-a');
    await shadow.writeFile('project-a', 'a.txt', 'middle\n');
    await shadow.writeFile('project-a', 'a.txt', 'final\n');
    await shadow.createFile('project-a', 'b.txt', 'created\n');
    const records: ShadowCommitCheckpointRecord[] = [];
    const controller = new ExecutionShadowWorkspaceController(fx.runtime, (record) => records.push(record));

    const result = await controller.commitIfPresent('chat-a', 'run-a');

    assert.equal(result.committed, true);
    assert.equal(result.snapshot?.status, 'committed');
    assert.deepEqual(result.publicationChanges.map((change) => [change.path, change.type]), [
      ['a.txt', 'modified'],
      ['b.txt', 'created'],
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0].toolCallId, 'shadow-commit:run-a');
    assert.deepEqual(records[0].changes.map((change) => change.path), ['a.txt', 'b.txt']);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'final\n');
    assert.equal(await fx.workspace.readFile('project-a', 'b.txt'), 'created\n');
    assert.equal(fx.runtime.get('chat-a', 'run-a'), undefined);
  } finally {
    await fx.cleanup();
  }
});

test('rename gera checkpoint delete create reversível', async () => {
  const fx = await fixture();
  try {
    const shadow = fx.runtime.workspace('chat-a', 'run-a', 'project-a');
    await shadow.renameFile('project-a', 'a.txt', 'renamed.txt');
    const records: ShadowCommitCheckpointRecord[] = [];
    const controller = new ExecutionShadowWorkspaceController(fx.runtime, (record) => records.push(record));

    const result = await controller.commitIfPresent('chat-a', 'run-a');

    assert.deepEqual(result.publicationChanges.map((change) => [change.path, change.type]), [
      ['a.txt', 'deleted'],
      ['renamed.txt', 'created'],
    ]);
    assert.equal(records.length, 1);
    assert.equal(await fx.workspace.exists('project-a', 'a.txt'), false);
    assert.equal(await fx.workspace.readFile('project-a', 'renamed.txt'), 'old\n');
  } finally {
    await fx.cleanup();
  }
});

test('falha do recorder não transforma commit concluído em falha de publicação', async () => {
  const fx = await fixture();
  try {
    await fx.runtime.workspace('chat-a', 'run-a', 'project-a').writeFile('project-a', 'a.txt', 'new\n');
    const controller = new ExecutionShadowWorkspaceController(fx.runtime, () => {
      throw new Error('checkpoint unavailable');
    });

    const result = await controller.commitIfPresent('chat-a', 'run-a');

    assert.equal(result.committed, true);
    assert.match(result.checkpointError ?? '', /checkpoint unavailable/i);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'new\n');
    assert.equal(fx.runtime.get('chat-a', 'run-a'), undefined);
  } finally {
    await fx.cleanup();
  }
});

test('stale base impede publicação e mantém shadow recuperável', async () => {
  const fx = await fixture();
  try {
    await fx.runtime.workspace('chat-a', 'run-a', 'project-a').writeFile('project-a', 'a.txt', 'shadow\n');
    await fx.workspace.writeFile('project-a', 'a.txt', 'external\n');
    const controller = new ExecutionShadowWorkspaceController(fx.runtime);

    await assert.rejects(() => controller.commitIfPresent('chat-a', 'run-a'), /mudou fora do Shadow Workspace/i);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'external\n');
    assert.ok(fx.runtime.get('chat-a', 'run-a'));
  } finally {
    await fx.cleanup();
  }
});

test('discardIfPresent e removeChat não publicam alterações', async () => {
  const fx = await fixture();
  try {
    await fx.runtime.workspace('chat-a', 'run-a', 'project-a').writeFile('project-a', 'a.txt', 'shadow\n');
    fx.runtime.begin('chat-a', 'run-b', 'project-a');
    const controller = new ExecutionShadowWorkspaceController(fx.runtime);

    const discarded = controller.discardIfPresent('chat-a', 'run-a');
    assert.equal(discarded?.status, 'discarded');
    assert.equal(controller.removeChat('chat-a'), 1);
    assert.equal(fx.runtime.list().length, 0);
    assert.equal(await fx.workspace.readFile('project-a', 'a.txt'), 'old\n');
  } finally {
    await fx.cleanup();
  }
});
