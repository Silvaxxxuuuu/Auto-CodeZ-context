import type { ExecutionTimelineEvent } from './execution-timeline';

export type RunToolFact = {
  toolCallId: string;
  toolName: string;
  phase: NonNullable<ExecutionTimelineEvent['activityPhase']>;
  updatedAt: number;
};

export type RunToolDigest = {
  observed: number;
  completed: number;
  failed: number;
  waiting: number;
  cancelled: number;
  running: number;
  tools: RunToolFact[];
};

/**
 * Count only explicitly recorded tool phases. A completed command is not
 * evidence that a test or build passed, and a timeline with no V2 events
 * cannot be interpreted as zero work.
 */
export function summarizeRecordedTools(events: ExecutionTimelineEvent[]): RunToolDigest {
  const latest = new Map<string, RunToolFact & { sequence: number }>();
  for (const event of events) {
    if (event.type !== 'structured_activity' || !event.toolCallId || !event.toolName || !event.activityPhase) continue;
    const key = JSON.stringify([event.chatId, event.runId, event.toolCallId]);
    const previous = latest.get(key);
    if (previous && previous.sequence >= event.sequence) continue;
    latest.set(key, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      phase: event.activityPhase,
      updatedAt: event.at,
      sequence: event.sequence,
    });
  }
  const tools = [...latest.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map((tool) => ({ toolCallId: tool.toolCallId, toolName: tool.toolName, phase: tool.phase, updatedAt: tool.updatedAt }));
  return {
    observed: tools.length,
    completed: tools.filter((tool) => tool.phase === 'completed').length,
    failed: tools.filter((tool) => tool.phase === 'failed').length,
    waiting: tools.filter((tool) => tool.phase === 'waiting').length,
    cancelled: tools.filter((tool) => tool.phase === 'cancelled').length,
    running: tools.filter((tool) => tool.phase === 'queued' || tool.phase === 'running').length,
    tools,
  };
}
