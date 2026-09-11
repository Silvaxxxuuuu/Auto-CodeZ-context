import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalRuntime } from '../src/agent/approval-runtime';
import type { AIToolCall } from '../src/ai/types';

function toolCall(id: string): AIToolCall {
  return { id, name: 'read_file', input: { path: 'src/index.ts' } };
}

function request(runtime: ApprovalRuntime, id: string, chatId = 'chat-a', runId = 'run-a') {
  return runtime.request({ projectId: 'project-a', chatId, runId, permissionLevel: 'ask', toolCall: toolCall(id) });
}

test('request creates a pending approval with a unique id', () => {
  const runtime = new ApprovalRuntime();
  const first = request(runtime, 'call-1');
  const second = request(runtime, 'call-2');

  assert.notEqual(first.id, second.id);
  assert.equal(runtime.get(first.id)?.toolCall.id, 'call-1');
  assert.equal(runtime.list().length, 2);
});

test('chat and run filters isolate approval ownership', () => {
  const runtime = new ApprovalRuntime();
  request(runtime, 'call-1', 'chat-a', 'run-a');
  request(runtime, 'call-2', 'chat-a', 'run-b');
  request(runtime, 'call-3', 'chat-b', 'run-c');

  assert.equal(runtime.list({ chatId: 'chat-a' }).length, 2);
  assert.equal(runtime.list({ chatId: 'chat-a', runId: 'run-b' })[0]?.toolCall.id, 'call-2');
  assert.equal(runtime.list({ chatId: 'chat-b' })[0]?.runId, 'run-c');
});

test('chat ownership can be updated without changing approval identity', () => {
  const runtime = new ApprovalRuntime();
  const approval = request(runtime, 'call-1');

  const updated = runtime.setChatId(approval.id, 'chat-b');

  assert.equal(updated.id, approval.id);
  assert.equal(updated.chatId, 'chat-b');
  assert.equal(runtime.get(approval.id)?.chatId, 'chat-b');
});

test('claim prevents duplicate processing until released', () => {
  const runtime = new ApprovalRuntime();
  const approval = request(runtime, 'call-1');

  assert.equal(runtime.claim(approval.id).id, approval.id);
  assert.equal(runtime.isInFlight(approval.id), true);
  assert.throws(() => runtime.claim(approval.id), /já está sendo processada/);

  runtime.release(approval.id);
  assert.equal(runtime.isInFlight(approval.id), false);
  assert.equal(runtime.claim(approval.id).id, approval.id);
});

test('resolve consumes an approval exactly once', () => {
  const runtime = new ApprovalRuntime();
  const approval = request(runtime, 'call-1');

  assert.equal(runtime.resolve(approval.id).id, approval.id);
  assert.equal(runtime.get(approval.id), undefined);
  assert.throws(() => runtime.resolve(approval.id), /Aprovação não encontrada/);
});

test('remove clears only approvals owned by the requested scope', () => {
  const runtime = new ApprovalRuntime();
  const first = request(runtime, 'call-1', 'chat-a', 'run-a');
  request(runtime, 'call-2', 'chat-a', 'run-b');
  request(runtime, 'call-3', 'chat-b', 'run-c');
  runtime.claim(first.id);

  const removed = runtime.remove({ chatId: 'chat-a', runId: 'run-a' });

  assert.deepEqual(removed.map((approval) => approval.id), [first.id]);
  assert.equal(runtime.isInFlight(first.id), false);
  assert.equal(runtime.list({ chatId: 'chat-a' }).length, 1);
  assert.equal(runtime.list({ chatId: 'chat-b' }).length, 1);
});

test('restore drops orphan approvals without chat or run ownership', () => {
  const runtime = new ApprovalRuntime();
  const valid = request(runtime, 'call-valid');
  const orphan = runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-orphan') });

  runtime.restore([valid, orphan]);

  assert.deepEqual(runtime.list().map((approval) => approval.id), [valid.id]);
});

test('clear removes every pending approval and processing lock', () => {
  const runtime = new ApprovalRuntime();
  const first = request(runtime, 'call-1');
  request(runtime, 'call-2', 'chat-b', 'run-b');
  runtime.claim(first.id);

  runtime.clear();

  assert.deepEqual(runtime.list(), []);
  assert.equal(runtime.isInFlight(first.id), false);
});

test('list returns approvals ordered by creation time', () => {
  const runtime = new ApprovalRuntime();
  const first = request(runtime, 'call-1');
  const second = request(runtime, 'call-2');

  assert.deepEqual(runtime.list().map((approval) => approval.id), [first.id, second.id]);
});
