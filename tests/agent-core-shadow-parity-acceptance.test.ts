import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { ShadowAwareWorkspaceRuntime } from '../src/agent/shadow-aware-workspace-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { IncrementalWorkspaceMutationRuntime } from '../src/agent-core/incremental-workspace-runtime';
import { OperationJournalRuntime } from '../src/agent-core/operation-journal';
import { DurableOperationJournal, OperationJournalStore } from '../src/agent-core/operation-journal-store';
import type { LocalStorage } from '../src/core/storage';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-shadow-parity-'));
  const project: ProjectRecord = {
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  const base = new WorkspaceRuntime(async () => [project]);
  const shadows = new ExecutionShadowWorkspaceRuntime(base);
  const workspace = new ShadowAwareWorkspaceRuntime(base, shadows);
  const tools = new ShadowAwareToolRuntime(workspace);
  const storage = new MemoryStorage();
  let id = 0;
  const journalRuntime = new OperationJournalRuntime({
    now: () => 1000 + id,
    createId: () => `op-${++id}`,
  });
  const journal = new DurableOperationJournal(
    journalRuntime,
    new OperationJournalStore(storage as unknown as LocalStorage),
  );
  await journal.init();

  const blobs = new Map<string, string>();
  const rollbackBlobs = {
    putText: async (value: string) => {
      const ref = `blob:test:${blobs.size + 1}`;
      blobs.set(ref, value);
      return ref;
    },
    getText: async (ref: string) => {
      const value = blobs.get(ref);
      if (value === undefined) throw new Error('rollback blob missing');
      return value;
    },
  };

  tools.configureShadowWorkspace(shadows);
  tools.configureIncrementalWorkspaceRuntime(
    new IncrementalWorkspaceMutationRuntime(base, journal, rollbackBlobs),
  );

  return {
    root,
    base,
    shadows,
    tools,
    journal,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

async function execute(
  tools: ShadowAwareToolRuntime,
  runId: string,
  toolCall: AIToolCall,
) {
  const result = await tools.execute('chat-a', 'project-a', 'unrestricted', toolCall, runId);
  assert.equal(result.ok, true, result.error);
  return result;
}

test('production incremental configuration mutates the real workspace without creating new Shadow Workspace state', async () => {
  const f = await fixture();
  const runId = 'run-v2';
  try {
    const multilineWrite = "export const value = 2;\nexport function greet() {\n  return 'hello';\n}\n";
    await f.base.createFile('project-a', 'src/write.ts', 'export const value = 1;\n');
    await execute(
      f.tools,
      runId,
      call('write-1', 'write_file', { path: 'src/write.ts', content: multilineWrite }),
    );
    assert.equal(await f.base.readFile('project-a', 'src/write.ts'), multilineWrite);
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await f.base.createFile('project-a', 'src/text.ts', 'export const value = 2;\n');
    await execute(
      f.tools,
      runId,
      call('replace-1', 'replace_text', {
        path: 'src/text.ts',
        oldText: 'value = 2',
        newText: 'value = 3',
      }),
    );
    assert.equal(await f.base.readFile('project-a', 'src/text.ts'), 'export const value = 3;\n');
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await f.base.createFile('project-a', 'src/range.ts', 'one\ntwo\nthree\n');
    await execute(
      f.tools,
      runId,
      call('range-1', 'replace_range', {
        path: 'src/range.ts',
        startLine: 2,
        endLine: 2,
        content: 'TWO',
      }),
    );
    assert.equal(await f.base.readFile('project-a', 'src/range.ts'), 'one\nTWO\nthree\n');
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await f.base.createFile('project-a', 'src/before.txt', 'one\ntwo\nthree\n');
    await execute(
      f.tools,
      runId,
      call('before-1', 'insert_before', {
        path: 'src/before.txt',
        line: 2,
        content: 'before-two',
      }),
    );
    assert.equal(await f.base.readFile('project-a', 'src/before.txt'), 'one\nbefore-two\ntwo\nthree\n');
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await f.base.createFile('project-a', 'src/after.txt', 'one\ntwo\nthree\n');
    await execute(
      f.tools,
      runId,
      call('after-1', 'insert_after', {
        path: 'src/after.txt',
        line: 2,
        content: 'after-two',
      }),
    );
    assert.equal(await f.base.readFile('project-a', 'src/after.txt'), 'one\ntwo\nafter-two\nthree\n');
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await f.base.createFile('project-a', 'src/symbol.ts', "export function greet() {\n  return 'hello';\n}\n");
    await execute(
      f.tools,
      runId,
      call('symbol-1', 'replace_symbol', {
        path: 'src/symbol.ts',
        symbol: 'greet',
        kind: 'function',
        content: "export function greet() {\n  return 'updated';\n}",
      }),
    );
    assert.match(await f.base.readFile('project-a', 'src/symbol.ts'), /return 'updated'/);
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await execute(
      f.tools,
      runId,
      call('create-1', 'create_file', { path: 'src/generated.ts', content: 'export const generated = true;\n' }),
    );
    assert.equal(await f.base.readFile('project-a', 'src/generated.ts'), 'export const generated = true;\n');
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await execute(
      f.tools,
      runId,
      call('folder-1', 'create_folder', { path: 'assets/generated' }),
    );
    assert.equal((await f.base.statPath('project-a', 'assets/generated')).exists, true);
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await execute(
      f.tools,
      runId,
      call('rename-1', 'rename_file', { from: 'src/generated.ts', to: 'src/renamed.ts' }),
    );
    assert.equal((await f.base.statPath('project-a', 'src/generated.ts')).exists, false);
    assert.equal(await f.base.readFile('project-a', 'src/renamed.ts'), 'export const generated = true;\n');
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    await execute(
      f.tools,
      runId,
      call('delete-1', 'delete_file', { path: 'src/renamed.ts' }),
    );
    assert.equal((await f.base.statPath('project-a', 'src/renamed.ts')).exists, false);
    assert.equal(f.shadows.get('chat-a', runId), undefined);

    const verified = f.journal.list({ runId }).filter((record) => record.status === 'verified');
    assert.equal(verified.length, 10);
    assert.deepEqual(
      verified.map((record) => record.toolCallId).sort(),
      ['after-1', 'before-1', 'create-1', 'delete-1', 'folder-1', 'range-1', 'rename-1', 'replace-1', 'symbol-1', 'write-1'],
    );
    assert.deepEqual(f.shadows.list(), []);
  } finally {
    await f.cleanup();
  }
});

test('legacy Shadow Workspace support remains isolated when incremental V2 is not configured', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-shadow-legacy-'));
  try {
    const base = new WorkspaceRuntime(async () => [{
      id: 'project-a',
      name: 'Project A',
      rootPath: root,
      createdAt: 1,
      updatedAt: 1,
    }]);
    await base.createFile('project-a', 'legacy.txt', 'base');
    const shadows = new ExecutionShadowWorkspaceRuntime(base);
    const tools = new ShadowAwareToolRuntime(new ShadowAwareWorkspaceRuntime(base, shadows));
    tools.configureShadowWorkspace(shadows);
    shadows.beginLegacy('chat-a', 'legacy-run', 'project-a');

    const result = await tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('legacy-write', 'write_file', { path: 'legacy.txt', content: 'shadow' }),
      'legacy-run',
    );

    assert.equal(result.ok, true, result.error);
    assert.equal(await base.readFile('project-a', 'legacy.txt'), 'base');
    assert.equal(shadows.get('chat-a', 'legacy-run')?.changes.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
