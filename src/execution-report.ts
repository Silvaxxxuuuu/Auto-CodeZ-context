import type { ExecutionManager, ExecutionSnapshot, ExecutionState } from './execution-manager';
import type { ExecutionPlanHistory, ExecutionPlanHistoryRecord } from './execution-plan-history';
import type { ExecutionEvidenceType, ExecutionPlan } from './execution-planner';
import type { ExecutionTimeline, ExecutionTimelineEvent } from './execution-timeline';

export type ExecutionCompletionProof = 'verified' | 'unplanned' | 'active' | 'failed' | 'interrupted' | 'incomplete' | 'unknown';

export type ExecutionEvidenceSummary = Record<ExecutionEvidenceType, number>;

export type ExecutionStepSummary = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
};

export type ExecutionReport = {
  chatId: string;
  runId: string;
  state?: ExecutionState;
  startedAt?: number;
  updatedAt?: number;
  currentTool?: string;
  error?: string;
  completionProof: ExecutionCompletionProof;
  plan?: ExecutionPlan;
  planArchived: boolean;
  planRemovedAt?: number;
  steps: ExecutionStepSummary;
  evidence: ExecutionEvidenceSummary;
  timeline: ExecutionTimelineEvent[];
};

const EMPTY_STEPS: ExecutionStepSummary = {
  total: 0,
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
};

const EMPTY_EVIDENCE: ExecutionEvidenceSummary = {
  tool: 0,
  test: 0,
  build: 0,
  file: 0,
  result: 0,
};

function clonePlan(plan: ExecutionPlan | undefined): ExecutionPlan | undefined {
  return plan ? structuredClone(plan) : undefined;
}

function reconstructSnapshot(events: ExecutionTimelineEvent[]): ExecutionSnapshot | undefined {
  if (!events.length) return undefined;
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const started = ordered.find((event) => event.type === 'started' && event.state);
  if (!started?.state) return undefined;

  const snapshot: ExecutionSnapshot = {
    chatId: started.chatId,
    runId: started.runId,
    state: started.state,
    startedAt: started.at,
    updatedAt: started.at,
    currentTool: started.currentTool,
    error: started.error,
  };

  for (const event of ordered) {
    if (event.chatId !== snapshot.chatId || event.runId !== snapshot.runId) continue;
    snapshot.updatedAt = Math.max(snapshot.updatedAt, event.at);
    if (event.type === 'state_changed' && event.state) {
      snapshot.state = event.state;
      if (event.state !== 'running' && event.state !== 'waiting_approval') snapshot.currentTool = undefined;
      if (event.state !== 'failed') snapshot.error = undefined;
    } else if (event.type === 'tool_changed') {
      snapshot.currentTool = event.currentTool;
    } else if (event.type === 'error') {
      snapshot.error = event.error;
    }
  }
  return snapshot;
}

function summarizeSteps(plan?: ExecutionPlan): ExecutionStepSummary {
  if (!plan) return { ...EMPTY_STEPS };
  const summary = { ...EMPTY_STEPS, total: plan.steps.length };
  for (const step of plan.steps) summary[step.status] += 1;
  return summary;
}

function summarizeEvidence(plan?: ExecutionPlan): ExecutionEvidenceSummary {
  const summary = { ...EMPTY_EVIDENCE };
  if (!plan) return summary;
  for (const step of plan.steps) {
    for (const evidence of step.evidence) summary[evidence.type] += 1;
  }
  return summary;
}

function completionProof(state: ExecutionState | undefined, plan?: ExecutionPlan): ExecutionCompletionProof {
  if (state === 'running' || state === 'waiting_approval' || state === 'idle') return 'active';
  if (state === 'failed') return 'failed';
  if (state === 'interrupted') return 'interrupted';
  if (state === 'completed') {
    if (!plan) return 'unplanned';
    return plan.status === 'completed' ? 'verified' : 'incomplete';
  }
  if (plan?.status === 'failed') return 'failed';
  if (plan && plan.status !== 'completed') return 'incomplete';
  return 'unknown';
}

function chooseHistoryRecord(records: ExecutionPlanHistoryRecord[]): ExecutionPlanHistoryRecord | undefined {
  return records.sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
}

export class ExecutionReportBuilder {
  constructor(
    private readonly executions: ExecutionManager,
    private readonly timeline: ExecutionTimeline,
    private readonly planHistory: ExecutionPlanHistory,
  ) {}

  build(chatId: string, runId: string): ExecutionReport | undefined {
    const timeline = this.timeline.list(chatId, runId);
    const live = this.executions.get(chatId);
    const snapshot = live?.runId === runId ? live : reconstructSnapshot(timeline);
    const history = chooseHistoryRecord(this.planHistory.list({ chatId, runId }));
    const plan = history?.plan;
    if (!snapshot && !plan && timeline.length === 0) return undefined;

    return {
      chatId,
      runId,
      state: snapshot?.state,
      startedAt: snapshot?.startedAt,
      updatedAt: snapshot?.updatedAt ?? history?.lastSeenAt,
      currentTool: snapshot?.currentTool,
      error: snapshot?.error,
      completionProof: completionProof(snapshot?.state, plan),
      plan: clonePlan(plan),
      planArchived: history?.removedAt !== undefined,
      planRemovedAt: history?.removedAt,
      steps: summarizeSteps(plan),
      evidence: summarizeEvidence(plan),
      timeline,
    };
  }

  list(chatId?: string): ExecutionReport[] {
    const runs = new Map<string, { chatId: string; runId: string; updatedAt: number }>();
    for (const event of this.timeline.list(chatId)) {
      const key = `${event.chatId}\u0000${event.runId}`;
      const current = runs.get(key);
      if (!current || event.at > current.updatedAt) runs.set(key, { chatId: event.chatId, runId: event.runId, updatedAt: event.at });
    }
    for (const record of this.planHistory.list({ chatId })) {
      const key = `${record.chatId}\u0000${record.runId}`;
      const current = runs.get(key);
      if (!current || record.lastSeenAt > current.updatedAt) runs.set(key, { chatId: record.chatId, runId: record.runId, updatedAt: record.lastSeenAt });
    }
    for (const snapshot of this.executions.list()) {
      if (chatId !== undefined && snapshot.chatId !== chatId) continue;
      const key = `${snapshot.chatId}\u0000${snapshot.runId}`;
      const current = runs.get(key);
      if (!current || snapshot.updatedAt > current.updatedAt) runs.set(key, { chatId: snapshot.chatId, runId: snapshot.runId, updatedAt: snapshot.updatedAt });
    }

    return [...runs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ chatId: reportChatId, runId }) => this.build(reportChatId, runId))
      .filter((report): report is ExecutionReport => Boolean(report));
  }
}
