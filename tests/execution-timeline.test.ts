import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionTimeline } from '../src/execution-timeline';
import type { ExecutionSnapshot } from '../src/execution-manager';

function snapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'running',
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('registra início e transições observáveis em ordem', () => {
  const timeline = new ExecutionTimeline();

  timeline.record({ type: 'upsert', snapshot: snapshot() });
  timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 1200, currentTool: 'read_file' }) });
  timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 1400, state: 'waiting_approval', currentTool: 'write_file' }) });
  timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 1600, state: 'failed', currentTool: undefined, error: 'Falhou' }) });

  const events = timeline.list('chat-a', 'run-a');
  assert.deepEqual(events.map((event) => event.type), [
    'started',
    'tool_changed',
    'state_changed',
    'tool_changed',
    'state_changed',
    'tool_changed',
    'error',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(events.at(-1)?.error, 'Falhou');
});

test('ignora snapshots duplicados e obsoletos da mesma execução', () => {
  const timeline = new ExecutionTimeline();
  const initial = snapshot();

  assert.equal(timeline.record({ type: 'upsert', snapshot: initial }).length, 1);
  assert.equal(timeline.record({ type: 'upsert', snapshot: { ...initial } }).length, 0);
  assert.equal(timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 900, state: 'failed' }) }).length, 0);
  assert.equal(timeline.list().length, 1);
});

test('uma nova run no mesmo chat inicia uma sequência independente', () => {
  const timeline = new ExecutionTimeline();
  timeline.record({ type: 'upsert', snapshot: snapshot() });
  timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 1200, state: 'completed' }) });
  timeline.record({ type: 'upsert', snapshot: snapshot({ runId: 'run-b', startedAt: 2000, updatedAt: 2000 }) });

  assert.equal(timeline.list('chat-a', 'run-a').length, 2);
  const secondRun = timeline.list('chat-a', 'run-b');
  assert.equal(secondRun.length, 1);
  assert.equal(secondRun[0].type, 'started');
  assert.equal(secondRun[0].at, 2000);
});

test('remoção stale não encerra a run atual', () => {
  const timeline = new ExecutionTimeline();
  timeline.record({ type: 'upsert', snapshot: snapshot({ runId: 'current-run' }) });

  assert.equal(timeline.record({ type: 'remove', chatId: 'chat-a', runId: 'old-run' }).length, 0);
  const removed = timeline.record({ type: 'remove', chatId: 'chat-a', runId: 'current-run' });

  assert.equal(removed.length, 1);
  assert.equal(removed[0].type, 'removed');
  assert.equal(removed[0].runId, 'current-run');
});

test('filtra por chat e run e devolve cópias', () => {
  const timeline = new ExecutionTimeline();
  timeline.record({ type: 'upsert', snapshot: snapshot() });
  timeline.record({ type: 'upsert', snapshot: snapshot({ chatId: 'chat-b', runId: 'run-b' }) });

  const filtered = timeline.list('chat-a');
  assert.equal(filtered.length, 1);
  filtered[0].error = 'mutação externa';
  assert.equal(timeline.list('chat-a')[0].error, undefined);
});

test('filtro combinado não vaza o mesmo runId entre chats diferentes', () => {
  const timeline = new ExecutionTimeline();
  timeline.record({ type: 'upsert', snapshot: snapshot({ chatId: 'chat-a', runId: 'shared-run' }) });
  timeline.record({ type: 'upsert', snapshot: snapshot({ chatId: 'chat-b', runId: 'shared-run', startedAt: 2000, updatedAt: 2000 }) });

  const chatA = timeline.list('chat-a', 'shared-run');
  const chatB = timeline.list('chat-b', 'shared-run');

  assert.equal(chatA.length, 1);
  assert.equal(chatB.length, 1);
  assert.equal(chatA[0].chatId, 'chat-a');
  assert.equal(chatB[0].chatId, 'chat-b');
});

test('limita memória sem reutilizar sequence', () => {
  const timeline = new ExecutionTimeline(2);
  timeline.record({ type: 'upsert', snapshot: snapshot() });
  timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 1100, currentTool: 'read_file' }) });
  timeline.record({ type: 'upsert', snapshot: snapshot({ updatedAt: 1200, state: 'completed', currentTool: undefined }) });

  const events = timeline.list();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.sequence), [3, 4]);
});

test('clear remove somente o histórico solicitado', () => {
  const timeline = new ExecutionTimeline();
  timeline.record({ type: 'upsert', snapshot: snapshot() });
  timeline.record({ type: 'upsert', snapshot: snapshot({ chatId: 'chat-b', runId: 'run-b' }) });

  timeline.clear('chat-a');

  assert.deepEqual(timeline.list('chat-a'), []);
  assert.equal(timeline.list('chat-b').length, 1);
});

test('recuperação registra recovered sem fabricar novo started', () => {
  const timeline = new ExecutionTimeline(100, () => 5000);
  timeline.record({ type: 'upsert', snapshot: snapshot() });

  const recovered = timeline.recordRecovery(snapshot({ state: 'interrupted', currentTool: undefined }), 5000);
  const events = timeline.list('chat-a', 'run-a');

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].type, 'recovered');
  assert.equal(recovered[0].at, 5000);
  assert.equal(recovered[0].startedAt, 1000);
  assert.equal(recovered[0].state, 'interrupted');
  assert.deepEqual(events.map((event) => event.type), ['started', 'recovered']);
});

test('recuperação idempotente não duplica fato histórico', () => {
  const timeline = new ExecutionTimeline(100, () => 5000);
  const interrupted = snapshot({ state: 'interrupted' });

  assert.equal(timeline.recordRecovery(interrupted, 5000).length, 1);
  assert.equal(timeline.recordRecovery(interrupted, 6000).length, 0);
  assert.equal(timeline.list('chat-a', 'run-a').length, 1);
});

test('restore usa recovered como cursor e próxima transição não cria started', () => {
  const timeline = new ExecutionTimeline();
  timeline.restore([{
    sequence: 7,
    chatId: 'chat-a',
    runId: 'run-a',
    at: 5000,
    type: 'recovered',
    state: 'interrupted',
    startedAt: 1000,
  }]);

  const next = timeline.record({ type: 'upsert', snapshot: snapshot({ state: 'running', updatedAt: 6000 }) });

  assert.equal(next.length, 1);
  assert.equal(next[0].type, 'state_changed');
  assert.deepEqual(timeline.list().map((event) => event.sequence), [7, 8]);
});
