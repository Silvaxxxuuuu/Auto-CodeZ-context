import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import type { FileDiff, ProjectRecord } from '../src/ai/types';
import { IncrementalWorkspaceMutationRuntime } from '../src/agent-core/incremental-workspace-runtime';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';
import { DurableOperationJournal, OperationJournalStore } from '../src/agent-core/operation-journal-store';
import type { LocalStorage } from '../src/core/storage';

type CheckpointRecord = {
  chatId: string;
  runId: string;
  projectId: string;
  toolCallId: string;
  operationId?: string;
  changes: FileDiff[];
};


class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

async function fixture(activity = new ActivityRuntime()): Promise<{ root: string; runtime: ToolRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-checkpoint-tool-'));
  const project: ProjectRecord = { id: 'project-test', name: 'Checkpoint Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  return {
    root,
    runtime: new ToolRuntime(workspace, undefined, activity),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('registra checkpoint somente após uma mutação de arquivo confirmada', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'notes.txt'), 'before');
    const records: CheckpointRecord[] = [];
    value.runtime.configureExecutionCheckpointRecorder((record) => records.push(record));

    const result = await value.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      { id: 'call-write', name: 'write_file', input: { path: 'notes.txt', content: 'after' } },
      'run-a',
    );

    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(path.join(value.root, 'notes.txt'), 'utf8'), 'after');
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      chatId: 'chat-a',
      runId: 'run-a',
      projectId: 'project-test',
      toolCallId: 'call-write',
      changes: result.changes,
    });
    assert.equal(records[0].changes[0].before, 'before');
    assert.equal(records[0].changes[0].after, 'after');
  } finally {
    await value.cleanup();
  }
});

test('não registra checkpoint para leitura ou execução sem diff de arquivo', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'notes.txt'), 'content');
    const records: CheckpointRecord[] = [];
    value.runtime.configureExecutionCheckpointRecorder((record) => records.push(record));

    const result = await value.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      { id: 'call-read', name: 'read_file', input: { path: 'notes.txt' } },
      'run-a',
    );

    assert.equal(result.ok, true);
    assert.equal(records.length, 0);
  } finally {
    await value.cleanup();
  }
});

test('falha do recorder não transforma uma mutação já persistida em falha da ferramenta', async () => {
  const activity = new ActivityRuntime();
  const events: Array<{ message: string; status: string }> = [];
  activity.subscribe((event) => events.push({ message: event.message, status: event.status }));
  const value = await fixture(activity);
  try {
    await fs.writeFile(path.join(value.root, 'notes.txt'), 'before');
    value.runtime.configureExecutionCheckpointRecorder(() => { throw new Error('checkpoint storage unavailable'); });

    const result = await value.runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      { id: 'call-write', name: 'write_file', input: { path: 'notes.txt', content: 'after' } },
      'run-a',
    );

    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(path.join(value.root, 'notes.txt'), 'utf8'), 'after');
    assert.equal(events.some((event) => event.status === 'failed' && /checkpoint não registrado/i.test(event.message)), true);
    assert.equal(events.some((event) => event.status === 'success' && event.message === 'Concluído: write_file'), true);
  } finally {
    await value.cleanup();
  }
});


test('checkpoint de mutação incremental carrega o mesmo operationId do Operation Journal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-checkpoint-operation-'));
  try {
    const project: ProjectRecord = { id: 'project-test', name: 'Checkpoint Project', rootPath: root, createdAt: 1, updatedAt: 1 };
    const workspace = new WorkspaceRuntime(async () => [project]);
    const storage = new MemoryStorage();
    const journal = new DurableOperationJournal(
      new OperationJournalRuntime({ createId: () => 'op-create-file' }),
      new OperationJournalStore(storage as unknown as LocalStorage),
    );
    await journal.init();
    const incremental = new IncrementalWorkspaceMutationRuntime(workspace, journal);
    const runtime = new ToolRuntime(workspace);
    runtime.configureIncrementalWorkspaceRuntime(incremental);
    const records: CheckpointRecord[] = [];
    runtime.configureExecutionCheckpointRecorder((record) => records.push(record));

    const result = await runtime.execute(
      'chat-a',
      'project-test',
      'unrestricted',
      { id: 'call-create', name: 'create_file', input: { path: 'src/new.ts', content: 'export const value = 1;' } },
      'run-a',
    );

    assert.equal(result.ok, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].operationId, 'op-create-file');
    assert.equal(journal.get('op-create-file')?.status, 'verified');
    assert.equal(records[0].toolCallId, 'call-create');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
