import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import type { FileDiff, ProjectRecord } from '../src/ai/types';

type CheckpointRecord = {
  chatId: string;
  runId: string;
  projectId: string;
  toolCallId: string;
  changes: FileDiff[];
};

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
