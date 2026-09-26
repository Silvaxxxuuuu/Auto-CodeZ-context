import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileDiff } from '../src/ai/types';
import { ExecutionCheckpointRuntime, type ExecutionCheckpointWorkspace } from '../src/execution-checkpoint';

function change(input: Partial<FileDiff> & Pick<FileDiff, 'path' | 'type'>): FileDiff {
  return {
    path: input.path,
    type: input.type,
    before: input.before ?? '',
    after: input.after ?? '',
    addedLines: input.addedLines ?? 0,
    removedLines: input.removedLines ?? 0,
    ...(input.renamedFrom ? { renamedFrom: input.renamedFrom } : {}),
  };
}

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
    const key = this.key(projectId, path);
    const value = this.files.get(key);
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

class FailAfterWriteWorkspace extends FakeWorkspace {
  private failed = false;

  constructor(private readonly failingPath: string, private readonly failingContent: string) {
    super();
  }

  override async writeFile(projectId: string, path: string, content: string): Promise<void> {
    await super.writeFile(projectId, path, content);
    if (!this.failed && path === this.failingPath && content === this.failingContent) {
      this.failed = true;
      throw new Error('simulated write failure');
    }
  }
}

function record(runtime: ExecutionCheckpointRuntime, changes: FileDiff[]) {
  return runtime.record({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolCallId: 'tool-a', changes });
}

test('restaura arquivo modificado somente quando o estado atual ainda corresponde ao diff', async () => {
  const runtime = new ExecutionCheckpointRuntime(() => 2000, () => 'checkpoint-a');
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'src/a.ts', 'novo');
  const checkpoint = record(runtime, [change({ path: 'src/a.ts', type: 'modified', before: 'antigo', after: 'novo', addedLines: 1, removedLines: 1 })]);

  const restored = await runtime.restore(checkpoint.id, workspace);

  assert.equal(await workspace.readFile('project-a', 'src/a.ts'), 'antigo');
  assert.equal(restored.status, 'restored');
  assert.equal(restored.restoredAt, 2000);
});

test('desfaz create, delete e rename em ordem inversa', async () => {
  const runtime = new ExecutionCheckpointRuntime(() => 3000, () => 'checkpoint-mixed');
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'created.txt', 'criado');
  workspace.seed('project-a', 'new-name.txt', 'renomeado e alterado');
  const checkpoint = record(runtime, [
    change({ path: 'created.txt', type: 'created', after: 'criado', addedLines: 1 }),
    change({ path: 'deleted.txt', type: 'deleted', before: 'apagado', removedLines: 1 }),
    change({ path: 'new-name.txt', type: 'renamed', renamedFrom: 'old-name.txt', before: 'original', after: 'renomeado e alterado', addedLines: 1, removedLines: 1 }),
  ]);

  await runtime.restore(checkpoint.id, workspace);

  assert.deepEqual(workspace.operations, [
    'rename:new-name.txt->old-name.txt',
    'write:old-name.txt',
    'create:deleted.txt',
    'delete:created.txt',
  ]);
  assert.equal(await workspace.readFile('project-a', 'old-name.txt'), 'original');
  assert.equal(await workspace.readFile('project-a', 'deleted.txt'), 'apagado');
  assert.equal(await workspace.exists('project-a', 'created.txt'), false);
});

test('mudança externa bloqueia toda a restauração antes da primeira mutação', async () => {
  const runtime = new ExecutionCheckpointRuntime(() => 4000, () => 'checkpoint-stale');
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'a.txt', 'estado-da-ia');
  workspace.seed('project-a', 'b.txt', 'alterado-pelo-usuario');
  const checkpoint = record(runtime, [
    change({ path: 'a.txt', type: 'modified', before: 'a-original', after: 'estado-da-ia' }),
    change({ path: 'b.txt', type: 'modified', before: 'b-original', after: 'estado-da-ia-b' }),
  ]);

  await assert.rejects(() => runtime.restore(checkpoint.id, workspace), /workspace mudou/i);

  assert.deepEqual(workspace.operations, []);
  assert.equal(await workspace.readFile('project-a', 'a.txt'), 'estado-da-ia');
  assert.equal(runtime.get(checkpoint.id)?.status, 'ready');
});

test('falha parcial durante rollback recompõe o estado anterior e mantém checkpoint pronto', async () => {
  const runtime = new ExecutionCheckpointRuntime(() => 4500, () => 'checkpoint-compensated');
  const workspace = new FailAfterWriteWorkspace('a.txt', 'a-original');
  workspace.seed('project-a', 'a.txt', 'a-after');
  workspace.seed('project-a', 'b.txt', 'b-after');
  const checkpoint = record(runtime, [
    change({ path: 'a.txt', type: 'modified', before: 'a-original', after: 'a-after', addedLines: 1, removedLines: 1 }),
    change({ path: 'b.txt', type: 'modified', before: 'b-original', after: 'b-after', addedLines: 1, removedLines: 1 }),
  ]);

  await assert.rejects(() => runtime.restore(checkpoint.id, workspace), /workspace foi recomposto/i);

  assert.equal(await workspace.readFile('project-a', 'a.txt'), 'a-after');
  assert.equal(await workspace.readFile('project-a', 'b.txt'), 'b-after');
  assert.equal(runtime.get(checkpoint.id)?.status, 'ready');
  assert.equal(runtime.get(checkpoint.id)?.restoredAt, undefined);
});

test('rejeita caminhos duplicados ou sobrepostos incluindo origem de rename', () => {
  const runtime = new ExecutionCheckpointRuntime(() => 5000, () => 'checkpoint-overlap');
  assert.throws(() => record(runtime, [
    change({ path: 'src/a.ts', type: 'modified', before: 'a', after: 'b' }),
    change({ path: 'SRC\\A.ts', type: 'deleted', before: 'b' }),
  ]), /sobrepostos/i);

  assert.throws(() => record(new ExecutionCheckpointRuntime(() => 5000, () => 'checkpoint-rename'), [
    change({ path: 'src/new.ts', type: 'renamed', renamedFrom: 'src/old.ts', before: 'a', after: 'a' }),
    change({ path: 'src/old.ts', type: 'created', after: 'x' }),
  ]), /sobrepostos/i);
});

test('checkpoint restaurado não pode ser aplicado duas vezes', async () => {
  const runtime = new ExecutionCheckpointRuntime(() => 6000, () => 'checkpoint-once');
  const workspace = new FakeWorkspace();
  workspace.seed('project-a', 'a.txt', 'novo');
  const checkpoint = record(runtime, [change({ path: 'a.txt', type: 'modified', before: 'antigo', after: 'novo' })]);

  await runtime.restore(checkpoint.id, workspace);
  await assert.rejects(() => runtime.restore(checkpoint.id, workspace), /já foi restaurado/i);
});

test('get e list devolvem cópias e removeChat preserva outros chats', () => {
  let id = 0;
  const runtime = new ExecutionCheckpointRuntime(() => 7000 + id, () => `checkpoint-${++id}`);
  const first = runtime.record({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolCallId: 'tool-a', changes: [change({ path: 'a.txt', type: 'created', after: 'a' })] });
  runtime.record({ chatId: 'chat-b', runId: 'run-b', projectId: 'project-a', toolCallId: 'tool-b', changes: [change({ path: 'b.txt', type: 'created', after: 'b' })] });

  first.changes[0].path = 'mutated.txt';
  const listed = runtime.list('chat-a');
  listed[0].changes[0].path = 'mutated-again.txt';

  assert.equal(runtime.get('checkpoint-1')?.changes[0].path, 'a.txt');
  assert.equal(runtime.removeChat('chat-a'), 1);
  assert.equal(runtime.get('checkpoint-1'), undefined);
  assert.equal(runtime.list('chat-b').length, 1);
});
