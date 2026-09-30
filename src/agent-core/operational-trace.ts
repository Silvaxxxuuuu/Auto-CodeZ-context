import type { ExecutionTimeline, ExecutionTimelineEvent } from '../execution-timeline';
import type { OperationalLedgerEvent } from '../operational-ledger';
import { OperationalLedgerRetrieval } from '../operational-ledger-retrieval';

export type OperationalTraceEntry = {
  source: 'ledger' | 'timeline';
  sequence: number;
  at: number;
  kind: string;
  state?: string;
  summary?: string;
  toolName?: string;
  capabilityId?: string;
  executionId?: string;
  resources?: string[];
  error?: string;
};

export type OperationalTraceSnapshot = {
  chatId: string;
  runId: string;
  eventCount: number;
  lastState?: string;
  diff: { files: number; addedLines: number; removedLines: number };
  tools: Array<{ name: string; count: number; failures: number }>;
  resources: string[];
  artifactIds: string[];
  errors: string[];
  entries: OperationalTraceEntry[];
};

const RECENT_LEDGER_EVENTS = 18;
const RECENT_TIMELINE_EVENTS = 18;
const MAX_TRACE_ENTRIES = 18;

function ledgerEntry(event: OperationalLedgerEvent): OperationalTraceEntry {
  return {
    source: 'ledger',
    sequence: event.sequence,
    at: event.timestamp,
    kind: event.category,
    state: event.state,
    summary: event.summary,
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.resources?.length ? { resources: [...event.resources] } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function timelineEntry(event: ExecutionTimelineEvent): OperationalTraceEntry {
  return {
    source: 'timeline',
    sequence: event.sequence,
    at: event.at,
    kind: event.type,
    ...(event.state ? { state: event.state } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
    ...(event.executionId ? { executionId: event.executionId } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
}

function compareTraceEntries(left: OperationalTraceEntry, right: OperationalTraceEntry): number {
  if (left.at !== right.at) return right.at - left.at;
  if (left.source !== right.source) return left.source === 'timeline' ? -1 : 1;
  return right.sequence - left.sequence;
}

export class OperationalTraceRuntime {
  constructor(
    private readonly retrieval: OperationalLedgerRetrieval,
    private readonly timeline: Pick<ExecutionTimeline, 'list'>,
  ) {}

  snapshot(chatId: string, runId: string): OperationalTraceSnapshot | undefined {
    const normalizedChatId = chatId.trim();
    const normalizedRunId = runId.trim();
    if (!normalizedChatId || !normalizedRunId) return undefined;

    const scope = { chatId: normalizedChatId, runId: normalizedRunId };
    const summary = this.retrieval.sessionSummary(scope);
    const ledger = this.retrieval.recentEvents(scope, RECENT_LEDGER_EVENTS).events.map(ledgerEntry);
    const timeline = this.timeline.list(normalizedChatId, normalizedRunId)
      .slice(-RECENT_TIMELINE_EVENTS)
      .map(timelineEntry);

    const entries = [...ledger, ...timeline]
      .sort(compareTraceEntries)
      .slice(0, MAX_TRACE_ENTRIES);

    if (!summary.eventCount && !entries.length) return undefined;

    return {
      chatId: normalizedChatId,
      runId: normalizedRunId,
      eventCount: summary.eventCount,
      ...(summary.lastState ? { lastState: summary.lastState } : {}),
      diff: { ...summary.diff },
      tools: summary.tools.slice(0, 12).map((tool) => ({ ...tool })),
      resources: summary.resources.slice(0, 24),
      artifactIds: summary.artifactIds.slice(0, 16),
      errors: summary.errors.slice(0, 8),
      entries,
    };
  }
}
