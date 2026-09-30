import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionTimeline } from '../src/execution-timeline';
import { ExecutionTimelineStore } from '../src/execution-timeline-store';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import type { StructuredActivityEvent } from '../src/agent-core/contracts';

function event(overrides: Partial<StructuredActivityEvent> = {}): StructuredActivityEvent {
  return {
    contractVersion: 1, id: 'tool:run-a:call-1:completed', kind: 'tool',
    phase: 'completed', chatId: 'chat-a', runId: 'run-a',
    toolCallId: 'call-1', capabilityId: 'run_command', createdAt: 1200,
    summary: 'A command containing sensitive arguments was executed.',
    subject: { command: 'echo PRIVATE_COMMAND_ARGUMENT' },
    ...overrides,
  };
}

const secureAdapter: SecureStorageAdapter = {
  isEncryptionAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decrypt: (value) => {
    const text = value.toString('utf8');
    if (!text.startsWith('encrypted:')) throw new Error('Invalid encrypted payload');
    return text.slice('encrypted:'.length);
  },
};

test('V2 tool timeline persists scoped identifiers and phases without sensitive command payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autocodez-v2-timeline-'));
  try {
    const timeline = new ExecutionTimeline();
    const first = timeline.recordStructuredActivity(event());
    assert.equal(first.length, 1);
    assert.deepEqual(first[0], {
      sequence: 1, chatId: 'chat-a', runId: 'run-a', at: 1200,
      type: 'structured_activity', toolCallId: 'call-1', toolName: 'run_command',
      activityId: 'tool:run-a:call-1:completed', activityPhase: 'completed',
    });
    assert.equal(timeline.recordStructuredActivity(event()).length, 0);
    timeline.recordStructuredActivity(event({
      chatId: 'chat-b', id: 'tool:run-a:call-1:failed', phase: 'failed', createdAt: 1300,
    }));
    assert.deepEqual(timeline.list('chat-a', 'run-a').map((e) => e.activityPhase), ['completed']);
    assert.deepEqual(timeline.list('chat-b', 'run-a').map((e) => e.activityPhase), ['failed']);

    const storage = new LocalStorage(root, secureAdapter);
    await storage.init();
    const store = new ExecutionTimelineStore(storage);
    await store.save(timeline.list());
    const encrypted = await readFile(path.join(root, 'execution-timeline.json'), 'utf8');
    assert.equal(encrypted.includes('PRIVATE_COMMAND_ARGUMENT'), false);
    const restored = new ExecutionTimeline();
    restored.restore(await store.load());
    assert.deepEqual(restored.list(), timeline.list());
    assert.equal(restored.recordStructuredActivity(event()).length, 0);
    assert.equal(restored.recordStructuredActivity(event({ id: 'tool:run-a:call-2:waiting', toolCallId: 'call-2', phase: 'waiting' })).length, 1);
    assert.equal(restored.list().at(-1)?.sequence, 3);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 30 : 0, retryDelay: 100 });
  }
});

test('V2 activity events cannot corrupt execution cursors or accept malformed payloads', () => {
  const timeline = new ExecutionTimeline();
  const snapshot = { chatId: 'chat-a', runId: 'run-a', state: 'running' as const, startedAt: 1000, updatedAt: 1000 };
  timeline.record({ type: 'upsert', snapshot });
  timeline.recordStructuredActivity(event());
  assert.deepEqual(timeline.record({ type: 'upsert', snapshot }), []);
  assert.throws(() => timeline.recordStructuredActivity(event({ chatId: '' })), /Chat/);
  assert.throws(() => timeline.recordStructuredActivity(event({ phase: 'unexpected' as StructuredActivityEvent['phase'] })), /Fase/);
  const restored = new ExecutionTimeline();
  restored.restore(timeline.list());
  assert.deepEqual(restored.record({ type: 'upsert', snapshot }), []);
  assert.deepEqual(timeline.list().map((e) => e.type), ['started', 'structured_activity']);
});
