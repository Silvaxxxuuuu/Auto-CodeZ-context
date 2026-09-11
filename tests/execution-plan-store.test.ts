import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage } from '../src/core/storage';
import { ExecutionPlanPersistence, ExecutionPlanStore } from '../src/execution-plan-store';
import { ExecutionPlanner, type ExecutionPlan } from '../src/execution-planner';

async function withStorage<T>(callback: (storage: LocalStorage, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-execution-plan-'));
  try {
    const storage = new LocalStorage(root, {
      isEncryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8'),
    });
    await storage.init();
    return await callback(storage, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: 'plan-a',
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Corrigir login',
    status: 'running',
    createdAt: 1000,
    updatedAt: 1200,
    steps: [
      {
        id: 'step-a',
        title: 'Inspecionar',
        status: 'running',
        createdAt: 1000,
        updatedAt: 1200,
        evidence: [{ type: 'tool', summary: 'Arquivo lido', reference: 'src/login.ts', createdAt: 1100 }],
      },
      {
        id: 'step-b',
        title: 'Testar',
        status: 'pending',
        createdAt: 1000,
        updatedAt: 1000,
        evidence: [],
      },
    ],
    ...overrides,
  };
}

test('persiste e restaura planos com cópias profundas', async () => {
  await withStorage(async (storage) => {
    const store = new ExecutionPlanStore(storage);
    const source = plan();
    await store.save([source]);

    source.objective = 'mutado depois do save';
    source.steps[0].evidence[0].summary = 'mutado';

    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].objective, 'Corrigir login');
    assert.equal(loaded[0].steps[0].evidence[0].summary, 'Arquivo lido');
  });
});

test('rejeita versão futura do arquivo persistido', async () => {
  await withStorage(async (storage, root) => {
    await writeFile(path.join(root, 'execution-plans.json'), JSON.stringify({ version: 99, plans: [plan()] }), 'utf8');
    const store = new ExecutionPlanStore(storage);
    assert.deepEqual(await store.load(), []);
  });
});

test('fila de persistência preserva a visão mais recente', async () => {
  await withStorage(async (storage) => {
    const store = new ExecutionPlanStore(storage);
    const persistence = new ExecutionPlanPersistence(store);

    persistence.schedule([plan({ updatedAt: 1200, objective: 'Primeiro' })]);
    persistence.schedule([plan({ updatedAt: 1300, objective: 'Segundo' })]);
    persistence.schedule([plan({ updatedAt: 1400, objective: 'Final' })]);
    await persistence.flush();

    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].objective, 'Final');
    assert.equal(loaded[0].updatedAt, 1400);
  });
});

test('planner restaura somente o plano mais recente por chat', () => {
  const planner = new ExecutionPlanner();
  planner.restore([
    plan({ id: 'old-plan', runId: 'old-run', updatedAt: 1200, status: 'completed', steps: [{ id: 'old-step', title: 'Antigo', status: 'completed', createdAt: 1000, updatedAt: 1200, evidence: [] }] }),
    plan({ id: 'new-plan', runId: 'new-run', updatedAt: 1800 }),
    plan({ id: 'other-plan', chatId: 'chat-b', runId: 'run-b', updatedAt: 1700 }),
  ]);

  assert.equal(planner.list().length, 2);
  assert.equal(planner.get('chat-a')?.id, 'new-plan');
  assert.equal(planner.get('chat-a')?.runId, 'new-run');
  assert.equal(planner.get('chat-b')?.id, 'other-plan');
});

test('planner restaura passo running como pending em vez de retomá-lo após crash', () => {
  const planner = new ExecutionPlanner();
  planner.restore([plan()]);

  const restored = planner.get('chat-a', 'run-a');
  assert.ok(restored);
  assert.equal(restored.steps[0].status, 'pending');
  assert.equal(restored.steps[1].status, 'pending');
  assert.equal(restored.status, 'pending');
});

test('planner ignora planos persistidos inválidos sem contaminar os válidos', () => {
  const planner = new ExecutionPlanner();
  const invalid = plan({
    id: '',
    chatId: 'broken',
    runId: 'broken-run',
  });

  planner.restore([invalid, plan({ id: 'valid', chatId: 'chat-ok', runId: 'run-ok' })]);

  assert.equal(planner.list().length, 1);
  assert.equal(planner.get('chat-ok')?.id, 'valid');
  assert.equal(planner.get('broken'), undefined);
});

test('planner rejeita estado persistido impossível com mais de um passo running', () => {
  const planner = new ExecutionPlanner();
  const impossible = plan({
    steps: [
      { id: 'a', title: 'A', status: 'running', createdAt: 1000, updatedAt: 1100, evidence: [] },
      { id: 'b', title: 'B', status: 'running', createdAt: 1000, updatedAt: 1100, evidence: [] },
    ],
  });

  planner.restore([impossible]);
  assert.deepEqual(planner.list(), []);
});
