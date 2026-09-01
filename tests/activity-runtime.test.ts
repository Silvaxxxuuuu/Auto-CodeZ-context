import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';

test('activity runtime isolates listener failures', () => {
  const runtime = new ActivityRuntime();
  const received: string[] = [];
  runtime.subscribe(() => { throw new Error('listener failure'); });
  runtime.subscribe((event) => received.push(event.message));

  const event = runtime.emit({ type: 'tool', message: 'Operação concluída', status: 'success' });

  assert.equal(event.message, 'Operação concluída');
  assert.deepEqual(received, ['Operação concluída']);
});

test('activity runtime preserves structured command results', () => {
  const runtime = new ActivityRuntime();
  const result = {
    command: 'npm test',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    startedAt: 100,
    finishedAt: 250,
    durationMs: 150,
  };
  let received: ReturnType<ActivityRuntime['emit']> | undefined;
  runtime.subscribe((event) => { received = event; });

  runtime.emit({ type: 'test', message: 'Concluído: run_command', status: 'success', toolName: 'run_command', commandResult: result });

  assert.deepEqual(received?.commandResult, result);
  assert.equal(received?.toolName, 'run_command');
});
