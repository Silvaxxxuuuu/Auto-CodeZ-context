import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalLedger } from '../src/operational-ledger';
import { OperationalLedgerRetrieval } from '../src/operational-ledger-retrieval';

function fixture() {
  const ledger = new OperationalLedger();
  ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'running',
    summary: 'Lendo arquivo.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    toolCallId: 'call-1',
    toolName: 'read_file',
    resources: ['src/a.ts'],
    timestamp: 1000,
  });
  ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'success',
    summary: 'Arquivo atualizado.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    toolCallId: 'call-2',
    toolName: 'write_file',
    resources: ['src/a.ts'],
    diff: { files: 1, addedLines: 10, removedLines: 2 },
    sourceRefs: ['https://example.com/docs'],
    timestamp: 1200,
  });
  ledger.record({
    actor: 'plugin',
    category: 'artifact',
    state: 'success',
    summary: 'Screenshot produzido.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    pluginId: 'autocodez.roblox-studio-manager',
    artifactIds: ['artifact-1'],
    timestamp: 1400,
  });
  ledger.record({
    actor: 'plugin',
    category: 'tool',
    state: 'failed',
    summary: 'Playtest falhou.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    pluginId: 'autocodez.roblox-studio-manager',
    toolName: 'run_playtest',
    error: 'capture failed',
    timestamp: 1600,
  });
  ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'success',
    summary: 'Outro chat.',
    chatId: 'chat-b',
    runId: 'run-b',
    toolName: 'read_file',
    timestamp: 1800,
  });
  return { ledger, retrieval: new OperationalLedgerRetrieval(ledger) };
}

test('session retrieval summary aggregates only the requested scope', () => {
  const { retrieval } = fixture();
  const summary = retrieval.sessionSummary({ chatId: 'chat-a', runId: 'run-a' });

  assert.equal(summary.eventCount, 4);
  assert.equal(summary.firstSequence, 1);
  assert.equal(summary.lastSequence, 4);
  assert.equal(summary.startedAt, 1000);
  assert.equal(summary.updatedAt, 1600);
  assert.equal(summary.lastState, 'failed');
  assert.deepEqual(summary.categories, { tool: 3, artifact: 1 });
  assert.deepEqual(summary.resources, ['src/a.ts']);
  assert.deepEqual(summary.artifactIds, ['artifact-1']);
  assert.deepEqual(summary.sourceRefs, ['https://example.com/docs']);
  assert.deepEqual(summary.errors, ['capture failed']);
  assert.deepEqual(summary.diff, { files: 1, addedLines: 10, removedLines: 2 });
  assert.deepEqual(summary.tools, [
    { name: 'read_file', count: 1, failures: 0 },
    { name: 'run_playtest', count: 1, failures: 1 },
    { name: 'write_file', count: 1, failures: 0 },
  ]);
});

test('session retrieval recent events uses newest-first bounded pagination', () => {
  const { retrieval } = fixture();
  const first = retrieval.recentEvents({ chatId: 'chat-a' }, 2);
  assert.deepEqual(first.events.map((event) => event.sequence), [4, 3]);
  assert.equal(first.hasMore, true);

  const second = retrieval.recentEvents({ chatId: 'chat-a' }, 2, 3);
  assert.deepEqual(second.events.map((event) => event.sequence), [2, 1]);
  assert.equal(second.hasMore, false);
});

test('session retrieval exposes changes errors artifacts and sources without unrelated events', () => {
  const { retrieval } = fixture();
  assert.deepEqual(retrieval.changes({ chatId: 'chat-a' }).events.map((event) => event.sequence), [2, 1]);
  assert.deepEqual(retrieval.errors({ chatId: 'chat-a' }).events.map((event) => event.sequence), [4]);
  assert.deepEqual(retrieval.artifacts({ chatId: 'chat-a' }).events.map((event) => event.sequence), [3]);
  assert.deepEqual(retrieval.sources({ chatId: 'chat-a' }).events.map((event) => event.sequence), [2]);
});

test('session retrieval validates bounded limits and cursors', () => {
  const { retrieval } = fixture();
  assert.throws(() => retrieval.recentEvents({}, 501), /Limite de recuperação/);
  assert.throws(() => retrieval.errors({}, 201), /Limite de recuperação/);
  assert.throws(() => retrieval.artifacts({}, 10, 0), /Cursor do ledger inválido/);
});
