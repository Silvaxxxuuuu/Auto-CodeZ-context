import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationalLedger } from '../src/operational-ledger';

test('operational ledger records ordered authoritative events and filters by causation fields', () => {
  const ledger = new OperationalLedger(100);
  const first = ledger.record({
    actor: 'agent',
    category: 'tool',
    state: 'running',
    summary: 'Executando ferramenta.',
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    toolCallId: 'call-a',
    toolName: 'plugin_call',
    timestamp: 1000,
  });
  const second = ledger.record({
    actor: 'plugin',
    category: 'job',
    state: 'success',
    summary: 'Playtest concluído.',
    pluginId: 'autocodez.roblox-studio-manager',
    jobId: 'job-a',
    causationId: 'call-a',
    artifactIds: ['artifact-a'],
    progress: 1,
    timestamp: 1200,
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(ledger.query({ runId: 'run-a' }).events.map((event) => event.eventId), [first.eventId]);
  assert.deepEqual(ledger.query({ pluginId: 'autocodez.roblox-studio-manager' }).events.map((event) => event.eventId), [second.eventId]);
  assert.deepEqual(ledger.query({ category: 'job' }).events.map((event) => event.eventId), [second.eventId]);
});

test('operational ledger paginates deterministically without reusing sequence after pruning', () => {
  const ledger = new OperationalLedger(3);
  for (let index = 0; index < 5; index += 1) {
    ledger.record({
      actor: 'runtime',
      category: 'system',
      state: 'success',
      summary: `Evento ${index + 1}`,
      timestamp: index + 1,
    });
  }

  assert.deepEqual(ledger.listAll().map((event) => event.sequence), [3, 4, 5]);
  const page = ledger.query({ afterSequence: 2, limit: 2 });
  assert.deepEqual(page.events.map((event) => event.sequence), [3, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(page.firstSequence, 3);
  assert.equal(page.lastSequence, 4);
  assert.deepEqual(ledger.query({ afterSequence: 4, limit: 2 }).events.map((event) => event.sequence), [5]);
});

test('operational ledger clones artifacts and details defensively', () => {
  const ledger = new OperationalLedger();
  const stored = ledger.record({
    actor: 'plugin',
    category: 'artifact',
    state: 'success',
    summary: 'Artifact produzido.',
    artifactIds: ['artifact-a'],
    details: { kind: 'image', bytes: 128 },
  });

  stored.artifactIds?.push('outside');
  if (stored.details) stored.details.kind = 'mutated';

  const current = ledger.listAll()[0];
  assert.deepEqual(current.artifactIds, ['artifact-a']);
  assert.deepEqual(current.details, { kind: 'image', bytes: 128 });

  const queried = ledger.query().events[0];
  queried.artifactIds?.push('outside-query');
  assert.deepEqual(ledger.listAll()[0].artifactIds, ['artifact-a']);
});

test('operational ledger redacts common secret forms before retaining text', () => {
  const ledger = new OperationalLedger();
  const event = ledger.record({
    actor: 'runtime',
    category: 'system',
    state: 'failed',
    summary: 'Bearer super-secret-token api_key=abc123 https://user:pass@example.com/path',
    error: 'password=hunter2 token:xyz',
    details: { diagnostic: 'secret=very-secret-value' },
  });

  assert.equal(event.summary.includes('super-secret-token'), false);
  assert.equal(event.summary.includes('abc123'), false);
  assert.equal(event.summary.includes('user:pass@'), false);
  assert.equal(event.error?.includes('hunter2'), false);
  assert.equal(event.error?.includes('xyz'), false);
  assert.equal(String(event.details?.diagnostic).includes('very-secret-value'), false);
});

test('operational ledger restore preserves persisted sequence and resequences pre-restore live events', () => {
  const ledger = new OperationalLedger();
  const live = ledger.record({
    actor: 'plugin',
    category: 'plugin',
    state: 'running',
    summary: 'Evento desta inicialização.',
    timestamp: 5000,
  });

  ledger.restore([{
    eventId: 'persisted-a',
    sequence: 10,
    timestamp: 1000,
    actor: 'runtime',
    category: 'execution',
    state: 'success',
    summary: 'Evento persistido.',
  }]);

  const events = ledger.listAll();
  assert.deepEqual(events.map((event) => event.sequence), [10, 11]);
  assert.equal(events[1].eventId, live.eventId);
});

test('operational ledger validates filters and bounded metadata', () => {
  const ledger = new OperationalLedger();
  assert.throws(() => ledger.query({ limit: 501 }), /Limite de consulta/);
  assert.throws(() => ledger.record({
    actor: 'runtime',
    category: 'system',
    state: 'running',
    summary: 'x',
    progress: 2,
  }), /Progresso/);
  assert.throws(() => ledger.record({
    actor: 'runtime',
    category: 'artifact',
    state: 'success',
    summary: 'x',
    artifactIds: Array.from({ length: 33 }, (_, index) => `a-${index}`),
  }), /artifacts demais/);
});

test('operational ledger isolates listener failures', () => {
  const ledger = new OperationalLedger();
  let observed = 0;
  ledger.subscribe(() => { throw new Error('listener failed'); });
  ledger.subscribe(() => { observed += 1; });

  ledger.record({
    actor: 'runtime',
    category: 'system',
    state: 'success',
    summary: 'Continua funcionando.',
  });

  assert.equal(observed, 1);
});
