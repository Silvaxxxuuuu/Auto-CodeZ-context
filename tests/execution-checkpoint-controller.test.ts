import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionCheckpointController } from '../src/execution-checkpoint-controller';
import { ExecutionCheckpointRuntime, type ExecutionCheckpointWorkspace } from '../src/execution-checkpoint';
import { ExecutionManager } from '../src/execution-manager';

class FakeWorkspace implements ExecutionCheckpointWorkspace {
  readonly files = new Map<string, string>();
  readonly operations: string[] = [];

  private key(projectId: string, path: string): string {
    return `${projectId}:${path}`;
  }

  seed(projectId: string, path: string, content: string): void {
    this.files.set(this.key(projectId, path), content);
  }

  async exists(projectId: string, path: string): Promise<boolean> {
    return this.files.has(this.key(projectId, path));
  }

  async readFile(projectId: string, path: string): Promise<string> {
    const value = this.files.get(this.key(projectId, path));
    if (value === undefined) throw new Error('Arquivo ausente.');
    return value;
  }

  async writeFile(projectId: string, path: string, content: string): Promise<void> {
    const key = this.key(projectId, path);
    if (!this.files.has(key)) throw new Error('Arquivo ausente.');
    this.operations.push(`write:${path}`);
    this.files.set(key, content);
  }

  async createFile(projectId: string, path: string, content: string): Promise<void> {
    const key = this.key(projectId, path);
    if (this.files.has(key)) throw new Error('Arquivo já existe.');
    this.operations.push(`create:${path}`);
    this.files.set(key, content);
  }

  async deleteFile(projectId: string, path: string): Promise<void> {
    const key = this.key(projectId, path);
    if (!this.files.has(key)) throw new Error('Arquivo ausente.');
    this.operations.push(`delete:${path}`);
    this.files.delete(key);
  }

  async renameFile(projectId: string, from: string, to: string): Promise<void> {
    const source = this.key(projectId, from);
    const destination = this.key(projectId, to);
    const content = this.files.get(source);
    if (content === undefined) throw new Error('Origem ausente.');
    if (this.files.has(destination)) throw new Error('Destino já existe.');
    this.operations.push(`rename:${from}->${to}`);
    this.files.delete(source);
    this.files.set(destination, content);
  }
}

function createRuntime(): ExecutionCheckpointRuntime {
  return new ExecutionCheckpointRuntime(() => 2000, () => 'checkpoint-a');
}

function seedCheckpoint(runtime: ExecutionCheckpointRuntime): void {
  runtime.record({
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    toolCallId: 'tool-a',
    changes: [{
      path: 'src/a.ts',
      type: 'modified',
      before: 'before',
      after: 'after',
      addedLines: 1,
      removedLines: 1,
    }],
  });
}

test('restaura somente o checkpoint pertencente ao escopo informado', async () => {
  const runtime = createRuntime();
  seedCheckpoint(runtime);
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'src/a.ts', 'after');
  const executions = new ExecutionManager();
  const changed: string[][] = [];
  const controller = new ExecutionCheckpointController(runtime, workspace, executions, (checkpoints) => changed.push(checkpoints.map((item) => item.id)));

  const restored = await controller.restore({ checkpointId: 'checkpoint-a', chatId: 'chat-a', runId: 'run-a' });

  assert.equal(restored.status, 'restored');
  assert.equal(await workspace.readFile('project-a', 'src/a.ts'), 'before');
  assert.deepEqual(changed, [['checkpoint-a']]);
});

test('rejeita checkpoint de outro chat ou execução antes de tocar no workspace', async () => {
  const runtime = createRuntime();
  seedCheckpoint(runtime);
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'src/a.ts', 'after');
  const controller = new ExecutionCheckpointController(runtime, workspace, new ExecutionManager());

  await assert.rejects(() => controller.restore({ checkpointId: 'checkpoint-a', chatId: 'chat-b', runId: 'run-a' }), /não pertence/i);
  await assert.rejects(() => controller.restore({ checkpointId: 'checkpoint-a', chatId: 'chat-a', runId: 'run-b' }), /não pertence/i);

  assert.deepEqual(workspace.operations, []);
  assert.equal(runtime.get('checkpoint-a')?.status, 'ready');
});

test('bloqueia rollback enquanto o chat possui execução ativa', async () => {
  const runtime = createRuntime();
  seedCheckpoint(runtime);
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'src/a.ts', 'after');
  const executions = new ExecutionManager();
  executions.start('chat-a', 1000, 'run-current');
  const controller = new ExecutionCheckpointController(runtime, workspace, executions);

  await assert.rejects(() => controller.restore({ checkpointId: 'checkpoint-a', chatId: 'chat-a', runId: 'run-a' }), /execução ativa/i);

  assert.deepEqual(workspace.operations, []);
  assert.equal(runtime.get('checkpoint-a')?.status, 'ready');
});

test('permite rollback quando o snapshot atual do chat já é terminal', async () => {
  const runtime = createRuntime();
  seedCheckpoint(runtime);
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'src/a.ts', 'after');
  const executions = new ExecutionManager();
  executions.start('chat-a', 1000, 'run-current');
  executions.update('chat-a', { state: 'completed', runId: 'run-current' }, 1100);
  const controller = new ExecutionCheckpointController(runtime, workspace, executions);

  const restored = await controller.restore({ checkpointId: 'checkpoint-a', chatId: 'chat-a', runId: 'run-a' });

  assert.equal(restored.status, 'restored');
  assert.equal(await workspace.readFile('project-a', 'src/a.ts'), 'before');
});

test('list valida filtros e devolve somente o escopo solicitado', () => {
  let id = 0;
  const runtime = new ExecutionCheckpointRuntime(() => 1000 + id, () => `checkpoint-${++id}`);
  runtime.record({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolCallId: 'tool-a', changes: [{ path: 'a.ts', type: 'created', before: '', after: 'a', addedLines: 1, removedLines: 0 }] });
  runtime.record({ chatId: 'chat-b', runId: 'run-b', projectId: 'project-a', toolCallId: 'tool-b', changes: [{ path: 'b.ts', type: 'created', before: '', after: 'b', addedLines: 1, removedLines: 0 }] });
  const controller = new ExecutionCheckpointController(runtime, new FakeWorkspace(), new ExecutionManager());

  assert.deepEqual(controller.list('chat-a').map((item) => item.chatId), ['chat-a']);
  assert.deepEqual(controller.list('chat-b', 'run-b').map((item) => item.runId), ['run-b']);
  assert.throws(() => controller.list('   '), /chat inválido/i);
});
