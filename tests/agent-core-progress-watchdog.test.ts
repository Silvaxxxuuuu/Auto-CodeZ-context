import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProgressWatchdog,
  type ProgressObservation,
} from '../src/agent-core/progress-watchdog';

function observation(
  name: string,
  input: Record<string, unknown>,
  signal?: { kind: 'file' | 'error' | 'plan' | 'result'; key: string },
): ProgressObservation {
  return {
    calls: [{ name, input }],
    ...(signal ? { signals: [signal] } : {}),
  };
}

test('ProgressWatchdog allows arbitrarily many rounds while each round produces new progress', () => {
  const watchdog = new ProgressWatchdog();
  for (let index = 0; index < 500; index += 1) {
    const decision = watchdog.observe(observation(
      'create_file',
      { path: `src/file-${index}.ts` },
      { kind: 'file', key: `src/file-${index}.ts:hash-${index}` },
    ));
    assert.equal(decision.action, 'continue');
    assert.equal(decision.reason, 'progress');
  }
  const snapshot = watchdog.snapshot();
  assert.equal(snapshot.totalObservedRounds, 500);
  assert.equal(snapshot.stagnantRounds, 0);
  assert.equal(snapshot.replanAttempts, 0);
});

test('ProgressWatchdog detects A/A repetition and forces replan before any stop', () => {
  const watchdog = new ProgressWatchdog();
  const first = watchdog.observe(observation('read_file', { path: 'same.ts' }));
  const second = watchdog.observe(observation('read_file', { path: 'same.ts' }));

  assert.equal(first.action, 'continue');
  assert.equal(second.action, 'replan');
  assert.equal(second.reason, 'repeated-pattern');
  assert.deepEqual(second.pattern, { period: 1, cycles: 2 });
  assert.equal(second.replanAttempts, 1);
});

test('ProgressWatchdog detects A/B/A/B cycles instead of relying on a round ceiling', () => {
  const watchdog = new ProgressWatchdog();
  const calls = [
    observation('search_files', { query: 'alpha' }),
    observation('read_file', { path: 'a.ts' }),
    observation('search_files', { query: 'alpha' }),
    observation('read_file', { path: 'a.ts' }),
  ];

  const decisions = calls.map((item) => watchdog.observe(item));
  assert.deepEqual(decisions.map((item) => item.action), ['continue', 'continue', 'continue', 'replan']);
  assert.equal(decisions[3].reason, 'repeated-pattern');
  assert.deepEqual(decisions[3].pattern, { period: 2, cycles: 2 });
});

test('ProgressWatchdog stops a confirmed loop only after the permitted replan also stagnates', () => {
  const watchdog = new ProgressWatchdog({ maxReplansWithoutProgress: 1 });

  assert.equal(watchdog.observe(observation('read_file', { path: 'same.ts' })).action, 'continue');
  assert.equal(watchdog.observe(observation('read_file', { path: 'same.ts' })).action, 'replan');

  assert.equal(watchdog.observe(observation('read_file', { path: 'same.ts' })).action, 'continue');
  const stopped = watchdog.observe(observation('read_file', { path: 'same.ts' }));
  assert.equal(stopped.action, 'stop_loop');
  assert.equal(stopped.reason, 'loop-after-replan');
  assert.equal(stopped.replanAttempts, 1);
});

test('novel evidence after a replan resets loop suspicion and permits unlimited further work', () => {
  const watchdog = new ProgressWatchdog();
  watchdog.observe(observation('read_file', { path: 'same.ts' }));
  assert.equal(watchdog.observe(observation('read_file', { path: 'same.ts' })).action, 'replan');

  const progress = watchdog.observe(observation(
    'write_file',
    { path: 'same.ts' },
    { kind: 'file', key: 'same.ts:new-hash' },
  ));
  assert.equal(progress.action, 'continue');
  assert.equal(progress.reason, 'progress');
  assert.equal(progress.replanAttempts, 0);
  assert.equal(progress.stagnantRounds, 0);

  for (let index = 0; index < 100; index += 1) {
    assert.equal(watchdog.observe(observation(
      'write_file',
      { path: `next-${index}.ts` },
      { kind: 'result', key: `operation-${index}` },
    )).action, 'continue');
  }
});

test('new errors count as diagnostic progress once, but repeating the same error does not', () => {
  const watchdog = new ProgressWatchdog();
  const first = watchdog.observe(observation(
    'run_command',
    { command: 'npm test' },
    { kind: 'error', key: 'typescript:TS2322:file-a:10' },
  ));
  const repeated = watchdog.observe(observation(
    'run_command',
    { command: 'npm test' },
    { kind: 'error', key: 'typescript:TS2322:file-a:10' },
  ));

  assert.equal(first.reason, 'progress');
  assert.equal(repeated.reason, 'observing');
  assert.equal(repeated.novelSignals, 0);
});

test('waiting for approval or external state does not consume stagnation budget', () => {
  const watchdog = new ProgressWatchdog();
  const waitingApproval = watchdog.observe({ calls: [], waiting: 'approval' });
  const waitingExternal = watchdog.observe({ calls: [], waiting: 'external' });

  assert.equal(waitingApproval.action, 'continue');
  assert.equal(waitingApproval.reason, 'waiting');
  assert.equal(waitingExternal.action, 'continue');
  assert.equal(watchdog.snapshot().totalObservedRounds, 0);
  assert.equal(watchdog.snapshot().stagnantRounds, 0);
});

test('different calls without any new evidence eventually force replan through stagnation', () => {
  const watchdog = new ProgressWatchdog({ stagnationRounds: 4, replanLoopScore: 99 });
  let decision;
  for (let index = 0; index < 4; index += 1) {
    decision = watchdog.observe(observation('search_files', { query: `different-${index}` }));
  }
  assert.equal(decision?.action, 'replan');
  assert.equal(decision?.reason, 'stagnation');
});

test('snapshot/restore preserves loop episode across pause or process reconstruction', () => {
  const first = new ProgressWatchdog();
  first.observe(observation('search_files', { query: 'alpha' }));
  first.observe(observation('read_file', { path: 'a.ts' }));
  const snapshot = first.snapshot();

  const restored = new ProgressWatchdog();
  restored.restore(snapshot);
  restored.observe(observation('search_files', { query: 'alpha' }));
  const decision = restored.observe(observation('read_file', { path: 'a.ts' }));

  assert.equal(decision.action, 'replan');
  assert.deepEqual(decision.pattern, { period: 2, cycles: 2 });
  assert.equal(restored.snapshot().totalObservedRounds, 4);
});

test('snapshot stores only hashes, not raw tool inputs or progress keys', () => {
  const watchdog = new ProgressWatchdog();
  watchdog.observe(observation(
    'write_file',
    { path: 'private/customer.ts', content: 'secret-source-text' },
    { kind: 'file', key: 'private/customer.ts:secret-hash-label' },
  ));
  watchdog.observe(observation('read_file', { path: 'private/customer.ts' }));

  const serialized = JSON.stringify(watchdog.snapshot());
  assert.equal(serialized.includes('private/customer.ts'), false);
  assert.equal(serialized.includes('secret-source-text'), false);
  assert.equal(serialized.includes('secret-hash-label'), false);
});

test('restore is fail-closed for malformed or incompatible watchdog state', () => {
  const watchdog = new ProgressWatchdog({ maxReplansWithoutProgress: 1, historyLimit: 8, maxCyclePeriod: 4 });
  const valid = watchdog.snapshot();

  assert.throws(() => watchdog.restore({ ...valid, version: 2 as 1 }), /inválido/i);
  assert.throws(() => watchdog.restore({ ...valid, seenSignalHashes: ['raw-secret'] }), /sinais inválidos/i);
  assert.throws(() => watchdog.restore({ ...valid, replanAttempts: 2 }), /replans/i);
  assert.throws(
    () => watchdog.restore({ ...valid, recentRoundFingerprints: Array.from({ length: 9 }, () => 'a'.repeat(64)) }),
    /historyLimit/i,
  );
});

test('constructor rejects impossible watchdog configuration', () => {
  assert.throws(() => new ProgressWatchdog({ replanLoopScore: 0 }), /inteiro >= 1/);
  assert.throws(() => new ProgressWatchdog({ maxCyclePeriod: 4, historyLimit: 7 }), /dois ciclos/i);
});
