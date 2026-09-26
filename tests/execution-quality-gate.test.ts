import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionQualityGateRuntime } from '../src/execution-quality-gate';
import type { ExecutionReport } from '../src/execution-report';

function report(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'completed',
    completionProof: 'verified',
    planArchived: false,
    steps: { total: 2, pending: 0, running: 0, completed: 2, failed: 0, skipped: 0 },
    evidence: { tool: 2, test: 1, build: 1, file: 3, result: 2 },
    timeline: [],
    ...overrides,
  };
}

test('gate passa apenas com conclusão verificada e evidências mínimas', () => {
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => 'gate-a');
  runtime.configure({
    chatId: 'chat-a',
    runId: 'run-a',
    requirements: [
      { type: 'test', minimum: 1, label: 'Testes obrigatórios' },
      { type: 'build', minimum: 1 },
      { type: 'file', minimum: 2 },
    ],
  });

  const evaluation = runtime.evaluate(report());
  assert.equal(evaluation?.status, 'passed');
  assert.equal(evaluation?.checks.every((check) => check.passed), true);
});

test('gate terminal falha quando evidência objetiva exigida não existe', () => {
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => 'gate-a');
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', requirements: [{ type: 'test', minimum: 2 }] });

  const evaluation = runtime.evaluate(report());
  assert.equal(evaluation?.status, 'failed');
  assert.equal(evaluation?.checks.find((check) => check.type === 'test')?.actual, 1);
  assert.match(evaluation?.reason ?? '', /critérios objetivos/i);
});

test('gate fica pending enquanto execução ainda está ativa', () => {
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => 'gate-a');
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', requirements: [{ type: 'test', minimum: 1 }] });

  const evaluation = runtime.evaluate(report({ state: 'running', completionProof: 'active', evidence: { tool: 0, test: 0, build: 0, file: 0, result: 0 } }));
  assert.equal(evaluation?.status, 'pending');
});

test('conclusão não planejada falha quando gate exige verified completion', () => {
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => 'gate-a');
  runtime.configure({ chatId: 'chat-a', runId: 'run-a' });

  const evaluation = runtime.evaluate(report({ completionProof: 'unplanned' }));
  assert.equal(evaluation?.status, 'failed');
  assert.equal(evaluation?.checks[0].type, 'verified_completion');
  assert.equal(evaluation?.checks[0].passed, false);
});

test('gate pode exigir somente evidências sem exigir plano verificado', () => {
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => 'gate-a');
  runtime.configure({
    chatId: 'chat-a',
    runId: 'run-a',
    requireVerifiedCompletion: false,
    requirements: [{ type: 'result', minimum: 1 }],
  });

  assert.equal(runtime.evaluate(report({ completionProof: 'unplanned' }))?.status, 'passed');
});

test('configuração é imutável por run, mas repetição idêntica é idempotente', () => {
  let id = 0;
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => `gate-${++id}`);
  const first = runtime.configure({ chatId: 'chat-a', runId: 'run-a', requirements: [{ type: 'test', minimum: 1 }] });
  const repeated = runtime.configure({ chatId: 'chat-a', runId: 'run-a', requirements: [{ type: 'test', minimum: 1 }] });
  assert.equal(repeated.id, first.id);

  assert.throws(
    () => runtime.configure({ chatId: 'chat-a', runId: 'run-a', requirements: [{ type: 'test', minimum: 2 }] }),
    /imutável/i,
  );
});

test('requisitos duplicados usam o mínimo mais forte e removem chat isoladamente', () => {
  const runtime = new ExecutionQualityGateRuntime(() => 1000, () => Math.random().toString());
  const gate = runtime.configure({
    chatId: 'chat-a',
    runId: 'run-a',
    requirements: [{ type: 'test', minimum: 1 }, { type: 'test', minimum: 3 }],
  });
  runtime.configure({ chatId: 'chat-b', runId: 'run-b' });

  assert.equal(gate.requirements.length, 1);
  assert.equal(gate.requirements[0].minimum, 3);
  assert.equal(runtime.removeChat('chat-a'), 1);
  assert.equal(runtime.get('chat-a', 'run-a'), undefined);
  assert.ok(runtime.get('chat-b', 'run-b'));
});

test('restore ignora entradas inválidas sem quebrar startup', () => {
  const runtime = new ExecutionQualityGateRuntime();
  runtime.restore([
    {
      id: 'gate-a',
      chatId: 'chat-a',
      runId: 'run-a',
      requireVerifiedCompletion: true,
      requirements: [{ type: 'test', minimum: 1 }],
      createdAt: 1000,
    },
    {
      id: '',
      chatId: '',
      runId: '',
      requireVerifiedCompletion: true,
      requirements: [],
      createdAt: -1,
    },
  ]);

  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.list()[0].id, 'gate-a');
});
