import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalStorage } from '../src/core/storage';
import { buildExecutionGraph } from '../src/execution-graph';
import type { ExecutionReport } from '../src/execution-report';
import { ExecutionTimeline } from '../src/execution-timeline';
import { ExecutionTimelineStore } from '../src/execution-timeline-store';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

function baseReport(timeline: ExecutionReport['timeline']): ExecutionReport {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'running',
    startedAt: 100,
    updatedAt: 300,
    completionProof: 'active',
    planArchived: false,
    steps: { total: 0, pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 },
    evidence: { tool: 0, test: 0, build: 0, file: 0, result: 0 },
    timeline,
  };
}

test('timeline registra decisão de aprovação como fato observável idempotente', () => {
  const timeline = new ExecutionTimeline(1000, () => 250);
  timeline.record({ type: 'upsert', snapshot: {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'waiting_approval',
    startedAt: 100,
    updatedAt: 200,
    currentTool: 'write_file',
  } });

  const first = timeline.recordApprovalDecision({
    chatId: 'chat-a',
    runId: 'run-a',
    approvalId: 'approval-a',
    toolCallId: 'tool-call-a',
    toolName: 'write_file',
    decision: 'approved',
  });
  const duplicate = timeline.recordApprovalDecision({
    chatId: 'chat-a',
    runId: 'run-a',
    approvalId: 'approval-a',
    toolCallId: 'tool-call-a',
    toolName: 'write_file',
    decision: 'approved',
    at: 260,
  });

  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'approval_decision');
  assert.equal(first[0].approvalDecision, 'approved');
  assert.equal(first[0].approvalId, 'approval-a');
  assert.equal(first[0].toolName, 'write_file');
  assert.deepEqual(duplicate, []);
});

test('decisão de aprovação restaurada não desloca cursor de estado', () => {
  const timeline = new ExecutionTimeline();
  timeline.restore([
    { sequence: 1, chatId: 'chat-a', runId: 'run-a', at: 100, type: 'started', state: 'running' },
    { sequence: 2, chatId: 'chat-a', runId: 'run-a', at: 200, type: 'state_changed', state: 'waiting_approval' },
    { sequence: 3, chatId: 'chat-a', runId: 'run-a', at: 500, type: 'approval_decision', approvalId: 'approval-a', toolCallId: 'tool-a', toolName: 'write_file', approvalDecision: 'approved' },
  ]);

  const emitted = timeline.record({ type: 'upsert', snapshot: {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'running',
    startedAt: 100,
    updatedAt: 300,
  } });

  assert.equal(emitted.some((event) => event.type === 'state_changed' && event.state === 'running'), true);
});

test('timeline persiste e restaura decisão de aprovação válida', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionTimelineStore(storage as unknown as LocalStorage);
  const event = {
    sequence: 7,
    chatId: 'chat-a',
    runId: 'run-a',
    at: 300,
    type: 'approval_decision' as const,
    approvalId: 'approval-a',
    toolCallId: 'tool-a',
    toolName: 'run_command',
    approvalDecision: 'denied' as const,
  };

  await store.save([event]);
  assert.deepEqual(await store.load(), [event]);
});

test('store descarta approval_decision incompleto', async () => {
  const storage = new MemoryStorage();
  await storage.write('execution-timeline.json', {
    version: 1,
    events: [{
      sequence: 1,
      chatId: 'chat-a',
      runId: 'run-a',
      at: 300,
      type: 'approval_decision',
      approvalId: 'approval-a',
      approvalDecision: 'approved',
    }],
  });
  const store = new ExecutionTimelineStore(storage as unknown as LocalStorage);
  assert.deepEqual(await store.load(), []);
});

test('Execution Graph projeta aprovação e recusa como fatos explícitos', () => {
  const graph = buildExecutionGraph(baseReport([
    { sequence: 1, chatId: 'chat-a', runId: 'run-a', at: 100, type: 'started', state: 'running' },
    { sequence: 2, chatId: 'chat-a', runId: 'run-a', at: 200, type: 'approval_decision', approvalId: 'approval-a', toolCallId: 'tool-a', toolName: 'write_file', approvalDecision: 'approved' },
    { sequence: 3, chatId: 'chat-a', runId: 'run-a', at: 300, type: 'approval_decision', approvalId: 'approval-b', toolCallId: 'tool-b', toolName: 'run_command', approvalDecision: 'denied' },
  ]));

  const approvals = graph.nodes.filter((node) => node.kind === 'approval');
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].label, 'Aprovado: write_file');
  assert.equal(approvals[0].approvalDecision, 'approved');
  assert.equal(approvals[1].label, 'Recusado: run_command');
  assert.equal(approvals[1].approvalDecision, 'denied');
});

test('timeline rejeita decisão malformada antes de persistir fato', () => {
  const timeline = new ExecutionTimeline();
  assert.throws(() => timeline.recordApprovalDecision({
    chatId: 'chat-a',
    runId: 'run-a',
    approvalId: '',
    toolCallId: 'tool-a',
    toolName: 'write_file',
    decision: 'approved',
  }), /Aprovação inválido/);
});
