import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProjectRecord } from '../src/ai/types';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { IncrementalWorkspaceMutationRuntime } from '../src/agent-core/incremental-workspace-runtime';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';
import { DurableOperationJournal, OperationJournalStore } from '../src/agent-core/operation-journal-store';
import { OperationRollbackRuntime } from '../src/agent-core/operation-rollback-runtime';
import type { LocalStorage } from '../src/core/storage';
import { ExecutionCheckpointRuntime } from '../src/execution-checkpoint';
import { ExecutionCheckpointController } from '../src/execution-checkpoint-controller';
import { ExecutionManager } from '../src/execution-manager';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

test('real tool mutation restores through checkpoint operationId and unified V2 rollback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-operation-restore-integration-'));
  try {
    const project: ProjectRecord = {
      id: 'project-a',
      name: 'Project A',
      rootPath: root,
      createdAt: 1,
      updatedAt: 1,
    };
    const workspace = new WorkspaceRuntime(async () => [project]);
    const storage = new MemoryStorage();
    const journal = new DurableOperationJournal(
      new OperationJournalRuntime({ createId: () => 'operation-create-a' }),
      new OperationJournalStore(storage as unknown as LocalStorage),
    );
    await journal.init();

    const incremental = new IncrementalWorkspaceMutationRuntime(workspace, journal);
    const rollback = new OperationRollbackRuntime(journal, incremental);
    const checkpoints = new ExecutionCheckpointRuntime(() => 2000, () => 'checkpoint-a');
    const tools = new ToolRuntime(workspace);
    tools.configureIncrementalWorkspaceRuntime(incremental);
    tools.configureExecutionCheckpointRecorder((record) => {
      if (record.operationId) checkpoints.record(record);
    });

    const executed = await tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      {
        id: 'tool-create-a',
        name: 'create_file',
        input: { path: 'generated/deep/index.ts', content: 'export const value = 1;' },
      },
      'run-a',
    );

    assert.equal(executed.ok, true);
    assert.equal(await workspace.readFile('project-a', 'generated/deep/index.ts'), 'export const value = 1;');

    const checkpoint = checkpoints.get('checkpoint-a');
    assert.equal(checkpoint?.operationId, 'operation-create-a');
    assert.equal(journal.get('operation-create-a')?.status, 'verified');

    const controller = new ExecutionCheckpointController(
      checkpoints,
      workspace,
      new ExecutionManager(),
      undefined,
      rollback,
    );
    const restored = await controller.restore({
      checkpointId: 'checkpoint-a',
      chatId: 'chat-a',
      runId: 'run-a',
    });

    assert.equal(restored.status, 'restored');
    assert.equal(restored.operationId, 'operation-create-a');
    assert.deepEqual(await workspace.statPath('project-a', 'generated/deep/index.ts'), { exists: false });
    assert.deepEqual(await workspace.statPath('project-a', 'generated/deep'), { exists: false });
    assert.deepEqual(await workspace.statPath('project-a', 'generated'), { exists: false });
    assert.equal(journal.get('operation-create-a')?.status, 'rolled_back');
    assert.equal(checkpoints.get('checkpoint-a')?.status, 'restored');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
