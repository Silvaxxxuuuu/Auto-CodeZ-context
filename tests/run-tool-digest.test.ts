import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRecordedTools } from '../src/run-tool-digest';
import type { ExecutionTimelineEvent } from '../src/execution-timeline';

function activity(sequence: number, toolCallId: string, toolName: string, phase: NonNullable<ExecutionTimelineEvent['activityPhase']>, chatId = 'chat-a', runId = 'run-a'): ExecutionTimelineEvent {
  return {
    sequence, chatId, runId, at: sequence * 100, type: 'structured_activity',
    activityId: `activity-${sequence}`, toolCallId, toolName, activityPhase: phase,
  };
}

test('tool digest counts final observed state once per tool call, not transition count', () => {
  const digest = summarizeRecordedTools([
    activity(1, 'call-1', 'run_command', 'waiting'),
    activity(2, 'call-2', 'read_file', 'completed'),
    activity(3, 'call-1', 'run_command', 'completed'),
    activity(4, 'call-3', 'inspect_instance', 'failed'),
    activity(5, 'call-4', 'interact_instance', 'waiting'),
    activity(6, 'call-5', 'start_process', 'running'),
  ]);
  assert.deepEqual({
    observed: digest.observed, completed: digest.completed, failed: digest.failed,
    waiting: digest.waiting, running: digest.running, cancelled: digest.cancelled,
  }, { observed: 5, completed: 2, failed: 1, waiting: 1, running: 1, cancelled: 0 });
  assert.deepEqual(digest.tools.map((tool) => tool.toolCallId), ['call-2', 'call-1', 'call-3', 'call-4', 'call-5']);
  assert.equal(digest.tools[1].phase, 'completed');
});

test('tool digest isolates matching call identifiers across chats and runs', () => {
  const digest = summarizeRecordedTools([
    activity(1, 'same', 'run_command', 'failed', 'chat-a', 'run-1'),
    activity(2, 'same', 'read_file', 'completed', 'chat-b', 'run-1'),
    activity(3, 'same', 'inspect_instance', 'waiting', 'chat-a', 'run-2'),
  ]);
  assert.equal(digest.observed, 3);
  assert.equal(digest.failed, 1);
  assert.equal(digest.completed, 1);
  assert.equal(digest.waiting, 1);
});

test('legacy-only timelines do not fabricate tool execution evidence', () => {
  const legacy: ExecutionTimelineEvent[] = [
    { sequence: 1, chatId: 'chat-a', runId: 'run-a', at: 100, type: 'started', state: 'running' },
    { sequence: 2, chatId: 'chat-a', runId: 'run-a', at: 200, type: 'tool_changed', currentTool: 'npm test' },
    { sequence: 3, chatId: 'chat-a', runId: 'run-a', at: 300, type: 'state_changed', state: 'completed' },
  ];
  assert.deepEqual(summarizeRecordedTools(legacy), {
    observed: 0, completed: 0, failed: 0, waiting: 0, cancelled: 0, running: 0, tools: [],
  });
});
