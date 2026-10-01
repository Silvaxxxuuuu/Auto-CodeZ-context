import assert from 'node:assert/strict';
import test from 'node:test';
import { toStructuredProcessLifecycleActivity } from '../src/agent/process-activity-bridge';
import type { ManagedProcessSnapshot } from '../src/agent/process-runtime';

function snapshot(overrides: Partial<ManagedProcessSnapshot> = {}): ManagedProcessSnapshot {
  return {
    id: 'process-a',
    projectId: 'project-a',
    command: 'npm run dev',
    status: 'running',
    pid: 1234,
    startedAt: 1000,
    outputSequence: 0,
    chatId: 'chat-a',
    runId: 'run-a',
    toolCallId: 'tool-start',
    capabilityId: 'process.start',
    executionId: 'process:run-a:tool-start',
    ...overrides,
  };
}

test('maps persistent process running and terminal states into the same V2 execution identity', () => {
  const running = toStructuredProcessLifecycleActivity(snapshot());
  assert.ok(running);
  assert.equal(running.phase, 'running');
  assert.equal(running.executionId, 'process:run-a:tool-start');
  assert.equal(running.capabilityId, 'process.start');
  assert.deepEqual(running.subject, { processId: 'process-a', command: 'npm run dev' });
  assert.equal(running.durationMs, undefined);

  const exited = toStructuredProcessLifecycleActivity(snapshot({
    status: 'exited',
    exitCode: 0,
    finishedAt: 1600,
  }));
  assert.ok(exited);
  assert.equal(exited.phase, 'completed');
  assert.equal(exited.executionId, running.executionId);
  assert.equal(exited.durationMs, 600);
  assert.match(exited.summary ?? '', /código 0/i);

  const stopped = toStructuredProcessLifecycleActivity(snapshot({
    status: 'stopped',
    finishedAt: 1400,
  }));
  assert.ok(stopped);
  assert.equal(stopped.phase, 'cancelled');
  assert.equal(stopped.executionId, running.executionId);

  const failed = toStructuredProcessLifecycleActivity(snapshot({
    status: 'failed',
    error: 'spawn failed',
    finishedAt: 1100,
  }));
  assert.ok(failed);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.executionId, running.executionId);
  assert.match(failed.summary ?? '', /spawn failed/);
});

test('ignores process lifecycle snapshots without complete run provenance', () => {
  assert.equal(toStructuredProcessLifecycleActivity(snapshot({ chatId: undefined })), undefined);
  assert.equal(toStructuredProcessLifecycleActivity(snapshot({ runId: undefined })), undefined);
  assert.equal(toStructuredProcessLifecycleActivity(snapshot({ toolCallId: undefined })), undefined);
  assert.equal(toStructuredProcessLifecycleActivity(snapshot({ executionId: undefined })), undefined);
});
