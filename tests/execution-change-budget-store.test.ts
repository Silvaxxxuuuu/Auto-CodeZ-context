import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalStorage } from '../src/core/storage';
import { ExecutionChangeBudgetPersistence, ExecutionChangeBudgetStore } from '../src/execution-change-budget-store';
import type { ExecutionChangeBudgetSnapshot } from '../src/execution-change-budget';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  failWrites = false;

  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (this.failWrites) throw new Error('write failed');
    this.values.set(name, structuredClone(value));
  }

  seed(name: string, value: unknown): void {
    this.values.set(name, structuredClone(value));
  }
}

function snapshot(input: Partial<ExecutionChangeBudgetSnapshot> = {}): ExecutionChangeBudgetSnapshot {
  return {
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    budget: input.budget ?? { maxFiles: 2, maxChangedLines: 20, maxCommands: 2, maxToolCalls: 5, maxDurationMs: 60_000 },
    usage: input.usage ?? { files: ['src/a.ts'], changedLines: 3, commands: 0, toolCalls: 1 },
    startedAt: input.startedAt ?? 1_000,
  };
}

test('store salva e carrega snapshots com cópias defensivas', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionChangeBudgetStore(storage as unknown as LocalStorage);
  const original = snapshot();

  await store.save([original]);
  original.usage.files.push('mutated.ts');
  original.budget.maxFiles = 99;

  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].usage.files, ['src/a.ts']);
  assert.equal(loaded[0].budget.maxFiles, 2);

  loaded[0].usage.files.push('outside.ts');
  assert.deepEqual((await store.load())[0].usage.files, ['src/a.ts']);
});

test('store ignora snapshots inválidos e deduplica chat/run pela versão mais recente', async () => {
  const storage = new MemoryStorage();
  storage.seed('execution-change-budget.json', {
    version: 1,
    snapshots: [
      snapshot({ runId: 'same', startedAt: 1_000 }),
      snapshot({ runId: 'same', startedAt: 2_000, budget: { maxFiles: 4 } }),
      snapshot({ runId: 'bad-negative', usage: { files: [], changedLines: -1, commands: 0, toolCalls: 0 } }),
      snapshot({ runId: 'bad-over-budget', budget: { maxFiles: 0 }, usage: { files: ['src/a.ts'], changedLines: 0, commands: 0, toolCalls: 0 } }),
      { ...snapshot({ runId: 'bad-time' }), startedAt: Number.NaN },
    ],
  });
  const store = new ExecutionChangeBudgetStore(storage as unknown as LocalStorage);

  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].runId, 'same');
  assert.equal(loaded[0].startedAt, 2_000);
  assert.equal(loaded[0].budget.maxFiles, 4);
});

test('store normaliza ids e arquivos sem alterar o orçamento', async () => {
  const storage = new MemoryStorage();
  storage.seed('execution-change-budget.json', {
    version: 1,
    snapshots: [snapshot({
      chatId: ' chat-a ',
      runId: ' run-a ',
      usage: { files: [' src/b.ts ', 'src/a.ts', 'src/a.ts'], changedLines: 3, commands: 0, toolCalls: 1 },
    })],
  });
  const store = new ExecutionChangeBudgetStore(storage as unknown as LocalStorage);

  const loaded = await store.load();
  assert.equal(loaded[0].chatId, 'chat-a');
  assert.equal(loaded[0].runId, 'run-a');
  assert.deepEqual(loaded[0].usage.files, ['src/a.ts', 'src/b.ts']);
  assert.equal(loaded[0].budget.maxDurationMs, 60_000);
});

test('persistence serializa a visão mais recente e expõe falha no flush', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionChangeBudgetStore(storage as unknown as LocalStorage);
  const persistence = new ExecutionChangeBudgetPersistence(store);

  persistence.schedule([snapshot({ runId: 'first' })]);
  persistence.schedule([snapshot({ runId: 'second', startedAt: 2_000 })]);
  await persistence.flush();
  assert.deepEqual((await store.load()).map((item) => item.runId), ['second']);

  storage.failWrites = true;
  persistence.schedule([snapshot({ runId: 'failed' })]);
  await assert.rejects(() => persistence.flush(), /write failed/i);
});
