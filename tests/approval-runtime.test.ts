import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalRuntime } from '../src/agent/approval-runtime';
import type { AIToolCall } from '../src/ai/types';

function toolCall(id: string): AIToolCall {
  return { id, name: 'read_file', input: { path: 'src/index.ts' } };
}

test('request creates a pending approval with a unique id', () => {
  const runtime = new ApprovalRuntime();
  const first = runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-1') });
  const second = runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-2') });

  assert.notEqual(first.id, second.id);
  assert.equal(runtime.get(first.id)?.toolCall.id, 'call-1');
  assert.equal(runtime.list().length, 2);
});

test('resolve consumes an approval exactly once', () => {
  const runtime = new ApprovalRuntime();
  const approval = runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-1') });

  assert.equal(runtime.resolve(approval.id).id, approval.id);
  assert.equal(runtime.get(approval.id), undefined);
  assert.throws(() => runtime.resolve(approval.id), /Aprovação não encontrada/);
});

test('clear removes every pending approval', () => {
  const runtime = new ApprovalRuntime();
  runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-1') });
  runtime.request({ projectId: 'project-b', permissionLevel: 'safe', toolCall: toolCall('call-2') });

  runtime.clear();
  assert.deepEqual(runtime.list(), []);
});

test('list returns approvals ordered by creation time', () => {
  const runtime = new ApprovalRuntime();
  const first = runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-1') });
  const second = runtime.request({ projectId: 'project-a', permissionLevel: 'ask', toolCall: toolCall('call-2') });

  assert.deepEqual(runtime.list().map((approval) => approval.id), [first.id, second.id]);
});
