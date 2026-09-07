import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExecutionGraph } from '../src/execution-graph';
import type { ExecutionReport } from '../src/execution-report';

function report(): ExecutionReport {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'completed',
    startedAt: 1000,
    updatedAt: 1800,
    completionProof: 'verified',
    planArchived: true,
    steps: { total: 1, pending: 0, running: 0, completed: 1, failed: 0, skipped: 0 },
    evidence: { tool: 0, test: 1, build: 0, file: 1, result: 0 },
    timeline: [
      { sequence: 1, chatId: 'chat-a', runId: 'run-a', at: 1000, type: 'started', state: 'running' },
      { sequence: 2, chatId: 'chat-a', runId: 'run-a', at: 1200, type: 'tool_changed', state: 'running', currentTool: 'read_file' },
      { sequence: 3, chatId: 'chat-a', runId: 'run-a', at: 1300, type: 'tool_changed', state: 'running' },
      { sequence: 4, chatId: 'chat-a', runId: 'run-a', at: 1700, type: 'state_changed', state: 'completed' },
      { sequence: 5, chatId: 'chat-a', runId: 'run-a', at: 1800, type: 'removed', state: 'completed' },
    ],
    plan: {
      id: 'plan-a',
      chatId: 'chat-a',
      runId: 'run-a',
      objective: 'Atualizar e validar o projeto',
      status: 'completed',
      createdAt: 1050,
      updatedAt: 1650,
      steps: [{
        id: 'step-a',
        title: 'Editar e testar',
        status: 'completed',
        createdAt: 1050,
        updatedAt: 1650,
        evidence: [
          { type: 'file', summary: 'Arquivo src/a.ts atualizado', reference: 'src/a.ts', createdAt: 1400 },
          { type: 'test', summary: 'Testes passaram', reference: 'npm test', createdAt: 1600 },
        ],
      }],
    },
  };
}

test('projeta somente fatos observáveis em ordem cronológica', () => {
  const graph = buildExecutionGraph(report());

  assert.deepEqual(graph.nodes.map((node) => node.kind), [
    'started',
    'tool',
    'evidence',
    'evidence',
    'state',
  ]);
  assert.deepEqual(graph.nodes.map((node) => node.at), [1000, 1200, 1400, 1600, 1700]);
  assert.equal(graph.nodes[1].tool, 'read_file');
  assert.equal(graph.nodes[2].evidenceType, 'file');
  assert.equal(graph.nodes[2].reference, 'src/a.ts');
  assert.equal(graph.nodes[2].stepId, 'step-a');
  assert.equal(graph.nodes[2].stepTitle, 'Editar e testar');
});

test('não transforma limpeza de ferramenta nem remoção em fatos do grafo', () => {
  const graph = buildExecutionGraph(report());

  assert.equal(graph.nodes.some((node) => node.label === 'removed'), false);
  assert.equal(graph.nodes.filter((node) => node.kind === 'tool').length, 1);
});

test('encadeia todos os fatos em sequência sem arestas órfãs', () => {
  const graph = buildExecutionGraph(report());

  assert.equal(graph.edges.length, graph.nodes.length - 1);
  for (let index = 0; index < graph.edges.length; index += 1) {
    assert.equal(graph.edges[index].from, graph.nodes[index].id);
    assert.equal(graph.edges[index].to, graph.nodes[index + 1].id);
    assert.equal(graph.edges[index].relation, 'sequence');
  }
});

test('representa recuperação e falha sem inventar um novo início', () => {
  const recovered = report();
  recovered.state = 'failed';
  recovered.completionProof = 'failed';
  recovered.plan = undefined;
  recovered.planArchived = false;
  recovered.steps = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
  recovered.evidence = { tool: 0, test: 0, build: 0, file: 0, result: 0 };
  recovered.timeline = [
    { sequence: 20, chatId: 'chat-a', runId: 'run-a', at: 2000, type: 'recovered', state: 'interrupted', startedAt: 1000 },
    { sequence: 21, chatId: 'chat-a', runId: 'run-a', at: 2200, type: 'state_changed', state: 'failed' },
    { sequence: 22, chatId: 'chat-a', runId: 'run-a', at: 2200, type: 'error', state: 'failed', error: 'Falha de provider' },
  ];

  const graph = buildExecutionGraph(recovered);
  assert.deepEqual(graph.nodes.map((node) => node.kind), ['recovered', 'state', 'error']);
  assert.equal(graph.nodes.some((node) => node.kind === 'started'), false);
  assert.equal(graph.nodes.at(-1)?.label, 'Falha de provider');
});

test('ordena timeline antes de evidência quando compartilham o mesmo timestamp', () => {
  const input = report();
  input.plan!.steps[0].evidence[0].createdAt = 1200;

  const graph = buildExecutionGraph(input);
  const at1200 = graph.nodes.filter((node) => node.at === 1200);
  assert.deepEqual(at1200.map((node) => node.source), ['timeline', 'plan']);
});

test('gera ids determinísticos para a mesma projeção', () => {
  const first = buildExecutionGraph(report());
  const second = buildExecutionGraph(report());

  assert.deepEqual(first, second);
});

test('rejeita relatório sem identidade canônica', () => {
  const invalid = report();
  invalid.chatId = '';
  assert.throws(() => buildExecutionGraph(invalid), /Chat do relatório inválido/);
});
