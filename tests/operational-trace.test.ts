import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalTraceRuntime } from '../src/agent-core/operational-trace';
import { ExecutionTimeline } from '../src/execution-timeline';
import { OperationalLedger } from '../src/operational-ledger';
import { OperationalLedgerRetrieval } from '../src/operational-ledger-retrieval';

test('OperationalTraceRuntime derives one run-scoped snapshot from ledger and timeline without new persistence', () => {
  const ledger = new OperationalLedger();
  const timeline = new ExecutionTimeline();

  ledger.record({
    actor: 'runtime',
    category: 'execution',
    state: 'running',
    summary: 'Execução iniciada.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    timestamp: 1000,
  });
  ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'success',
    summary: 'Arquivo criado.',
    chatId: 'chat-a',
    runId: 'run-a',
    toolCallId: 'call-1',
    toolName: 'create_file',
    resources: ['src/a.ts'],
    diff: { files: 1, addedLines: 8, removedLines: 0 },
    timestamp: 1200,
  });
  ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'failed',
    summary: 'Teste falhou.',
    chatId: 'chat-a',
    runId: 'run-a',
    toolCallId: 'call-2',
    toolName: 'run_command',
    error: 'exit code 1',
    timestamp: 1400,
  });
  ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'success',
    summary: 'Outro chat.',
    chatId: 'chat-b',
    runId: 'run-b',
    toolName: 'read_file',
    timestamp: 1600,
  });

  timeline.restore([{
    sequence: 10,
    chatId: 'chat-a',
    runId: 'run-a',
    at: 1300,
    type: 'structured_activity',
    toolCallId: 'call-1',
    toolName: 'create_file',
    capabilityId: 'workspace.create_file',
    activityId: 'activity-1',
    activityPhase: 'completed',
  }, {
    sequence: 11,
    chatId: 'chat-a',
    runId: 'run-a',
    at: 1500,
    type: 'structured_activity',
    toolCallId: 'call-process',
    toolName: 'start_process',
    capabilityId: 'process.start',
    executionId: 'process:run-a:call-process',
    activityId: 'activity-2',
    activityPhase: 'running',
  }]);

  const runtime = new OperationalTraceRuntime(new OperationalLedgerRetrieval(ledger), timeline);
  const snapshot = runtime.snapshot('chat-a', 'run-a');

  assert.ok(snapshot);
  assert.equal(snapshot.eventCount, 3);
  assert.equal(snapshot.lastState, 'failed');
  assert.deepEqual(snapshot.diff, { files: 1, addedLines: 8, removedLines: 0 });
  assert.deepEqual(snapshot.resources, ['src/a.ts']);
  assert.deepEqual(snapshot.errors, ['exit code 1']);
  assert.equal(snapshot.entries.some((entry) => entry.source === 'timeline' && entry.capabilityId === 'process.start'), true);
  assert.equal(snapshot.entries.some((entry) => entry.executionId === 'process:run-a:call-process'), true);
  assert.equal(snapshot.entries.some((entry) => entry.summary === 'Outro chat.'), false);
});

test('OperationalTraceRuntime returns undefined when the requested run has no evidence', () => {
  const ledger = new OperationalLedger();
  const timeline = new ExecutionTimeline();
  const runtime = new OperationalTraceRuntime(new OperationalLedgerRetrieval(ledger), timeline);

  assert.equal(runtime.snapshot('chat-a', 'run-a'), undefined);
});
