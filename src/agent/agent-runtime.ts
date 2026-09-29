import crypto from 'node:crypto';
import type { AIMessage, AIProviderConfig, AIResponse, AIStreamEvent, AIToolCall, AIToolDefinition, AIToolResult, ApprovalRequest, ChatRecord, PermissionLevel } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ToolRuntime } from './tool-runtime';
import { SYSTEM_PROJECT_ID } from './command-runtime';
import { ChatRuntime } from '../ai/chat-runtime';
import { createToolActivitySnapshot, toActivityInput } from './tool-activity-bridge';
import {
  ProgressWatchdog,
  type ProgressSignal,
  type ProgressWatchdogDecision,
  type ProgressWatchdogSnapshot,
} from '../agent-core/progress-watchdog';

const STATE_FILE = 'agent-runs.json';
const WATCHDOG_REPLAN_CONTEXT = `
Auto CodeZ internal recovery directive:
The progress watchdog detected a repeated or stagnant tool strategy. Replan before making another tool call.
- Do not repeat the same tool/input sequence merely because it failed or returned the same information.
- Re-read the actual evidence already present in tool results and choose a materially different next step.
- Preserve completed work. Do not restart the task from scratch.
- If the objective is already complete, finish instead of issuing more tools.
`.trim();

type StreamEmitter = (event: AIStreamEvent) => void;

function stableToolValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableToolValue(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableToolValue(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolCallSignature(call: AIToolCall): string {
  return `${call.name}:${stableToolValue(call.input)}`;
}

function progressHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function progressSignalsFor(call: AIToolCall, result: AIToolResult): ProgressSignal[] {
  if (result.pendingApproval) return [];
  const signals: ProgressSignal[] = [];

  for (const change of result.changes ?? []) {
    signals.push({
      kind: 'file',
      key: [
        change.type,
        change.renamedFrom ?? '',
        change.path,
        progressHash(change.after),
      ].join(':'),
    });
  }

  if (result.commandResult) {
    signals.push({
      kind: 'command',
      key: [
        result.commandResult.command,
        result.commandResult.exitCode,
        result.commandResult.timedOut ? 'timeout' : 'completed',
        progressHash(result.commandResult.stdout),
        progressHash(result.commandResult.stderr),
      ].join(':'),
    });
  }

  if (result.gitResult) {
    signals.push({
      kind: 'result',
      key: [
        'git',
        result.gitResult.operation,
        result.gitResult.branch,
        progressHash(result.gitResult.output),
      ].join(':'),
    });
  }

  for (const source of result.sources ?? []) {
    signals.push({ kind: 'source', key: source.url });
  }

  if (result.error) {
    signals.push({ kind: 'error', key: `${call.name}:${result.error}` });
  }

  if (
    result.ok
    && result.output
    && !result.changes?.length
    && !result.commandResult
    && !result.gitResult
    && !result.sources?.length
  ) {
    signals.push({ kind: 'result', key: `${call.name}:${progressHash(result.output)}` });
  }

  return signals;
}

function freshWatchdogSnapshot(): ProgressWatchdogSnapshot {
  return new ProgressWatchdog().snapshot();
}

function normalizeWatchdogSnapshot(snapshot: ProgressWatchdogSnapshot | undefined): ProgressWatchdogSnapshot | undefined {
  if (!snapshot) return freshWatchdogSnapshot();
  try {
    const watchdog = new ProgressWatchdog();
    watchdog.restore(snapshot);
    return watchdog.snapshot();
  } catch {
    return undefined;
  }
}

function duplicatePendingApprovalResult(call: AIToolCall, approvalId: string): AIToolResult {
  return {
    toolCallId: call.id,
    ok: true,
    output: `Chamada duplicada não executada: uma operação idêntica já aguarda aprovação local (${approvalId}). Não repita esta operação; aguarde o resultado da chamada já pendente.`,
  };
}

type PendingRun = {
  runId: string;
  config: AIProviderConfig;
  chat: ChatRecord;
  projectContext?: string;
  permission: PermissionLevel;
  workingChat: ChatRecord;
  pendingApprovalIds: string[];
  approvalCalls: Record<string, AIToolCall>;
  toolRounds: number;
  progressWatchdog: ProgressWatchdogSnapshot;
  replanPending?: boolean;
  lastError?: string;
  streamEmitter?: StreamEmitter;
};

interface PersistedPendingRun {
  runId: string;
  config: AIProviderConfig;
  chat: ChatRecord;
  projectContext?: string;
  permission: PermissionLevel;
  workingChat: ChatRecord;
  pendingApprovalIds: string[];
  approvalCalls: Record<string, AIToolCall>;
  toolRounds: number;
  progressWatchdog?: ProgressWatchdogSnapshot;
  replanPending?: boolean;
  lastError?: string;
}

interface PersistedAgentState {
  version: 3;
  runs: PersistedPendingRun[];
  approvals: ApprovalRequest[];
}

export interface AgentStateStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

export interface AgentRunResult {
  chatId: string;
  response: AIResponse;
  toolRounds: number;
  pendingApprovalIds: string[];
  messages: AIMessage[];
}

export type AgentRunSummary = {
  runId: string;
  chatId: string;
  toolRounds: number;
  pendingApprovalIds: string[];
};

export class AgentRuntime {
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly recoverableRuns = new Map<string, PendingRun>();
  private persistenceWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly tools: ToolRuntime,
    private readonly activity = new ActivityRuntime(),
    private readonly storage?: AgentStateStorage,
  ) {}

  async init(): Promise<void> {
    if (!this.storage) return;
    const stored = await this.storage.read<PersistedAgentState | { version: 1 | 2; runs: PersistedPendingRun[]; approvals: ApprovalRequest[] }>(
      STATE_FILE,
      { version: 3, runs: [], approvals: [] },
    );
    if (!stored || !Array.isArray(stored.runs) || !Array.isArray(stored.approvals)) return;

    this.pendingRuns.clear();
    this.recoverableRuns.clear();

    const normalizedRuns = stored.runs
      .filter((run) => run?.chat?.id && Array.isArray(run.pendingApprovalIds) && Array.isArray(run.workingChat?.messages))
      .flatMap((run): PendingRun[] => {
        const progressWatchdog = normalizeWatchdogSnapshot(run.progressWatchdog);
        if (!progressWatchdog) return [];
        return [{
          ...run,
          runId: run.runId || crypto.randomUUID(),
          progressWatchdog,
          replanPending: Boolean(run.replanPending),
        }];
      });

    const owners = new Map<string, { chatId: string; runId: string; call: AIToolCall }>();
    for (const run of normalizedRuns) {
      for (const approvalId of run.pendingApprovalIds) {
        const call = run.approvalCalls?.[approvalId];
        if (call) owners.set(approvalId, { chatId: run.chat.id, runId: run.runId, call });
      }
    }

    const restoredApprovals = stored.approvals.flatMap((approval) => {
      const owner = owners.get(approval.id);
      if (!owner) return [];
      return [{ ...approval, chatId: owner.chatId, runId: owner.runId, toolCall: owner.call }];
    });

    this.tools.restoreApprovals(restoredApprovals);
    const approvalsById = new Map(this.tools.listApprovals().map((approval) => [approval.id, approval]));

    for (const run of normalizedRuns) {
      if (run.pendingApprovalIds.length) {
        const validIds = run.pendingApprovalIds.filter((id) => {
          const approval = approvalsById.get(id);
          return Boolean(run.approvalCalls?.[id] && approval?.chatId === run.chat.id && approval.runId === run.runId);
        });
        if (!validIds.length) continue;
        const pending: PendingRun = { ...run, pendingApprovalIds: validIds };
        for (const approvalId of validIds) this.pendingRuns.set(approvalId, pending);
        continue;
      }
      this.recoverableRuns.set(run.runId, { ...run });
    }

    await this.persist();
  }

  hasPendingForChat(chatId: string): boolean {
    for (const run of this.pendingRuns.values()) if (run.chat.id === chatId) return true;
    return false;
  }

  hasRecoverableForChat(chatId: string): boolean {
    for (const run of this.recoverableRuns.values()) if (run.chat.id === chatId) return true;
    return false;
  }

  listPendingRuns(): AgentRunSummary[] {
    const unique = new Map<string, PendingRun>();
    for (const run of this.pendingRuns.values()) unique.set(run.runId, run);
    return [...unique.values()].map((run) => ({
      runId: run.runId,
      chatId: run.chat.id,
      toolRounds: run.toolRounds,
      pendingApprovalIds: [...run.pendingApprovalIds],
    }));
  }

  listRecoverableRuns(): Array<{ runId: string; chatId: string; toolRounds: number }> {
    return [...this.recoverableRuns.values()].map((run) => ({ runId: run.runId, chatId: run.chat.id, toolRounds: run.toolRounds }));
  }

  listExternalToolDefinitions(): AIToolDefinition[] {
    return this.tools.listDefinitions();
  }

  listExternalApprovals(filters?: { chatId?: string; runId?: string }): ApprovalRequest[] {
    return this.tools.listApprovals(filters);
  }

  async executeExternalTool(input: {
    chatId: string;
    projectId: string;
    runId: string;
    permission: PermissionLevel;
    call: AIToolCall;
  }): Promise<AIToolResult> {
    const result = await this.tools.execute(input.chatId, input.projectId, input.permission, input.call, input.runId);
    this.emitToolActivity(input.runId, input.chatId, input.call, result);
    return result;
  }

  async approveExternalTool(approvalId: string): Promise<AIToolResult> {
    return this.tools.approve(approvalId);
  }

  denyExternalTool(approvalId: string): boolean {
    return this.tools.deny(approvalId);
  }

  getPendingRunId(approvalId: string): string {
    return this.getPending(approvalId).runId;
  }

  async run(
    config: AIProviderConfig,
    chat: ChatRecord,
    projectContext: string | undefined,
    permission: PermissionLevel,
    runId: string = crypto.randomUUID(),
  ): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    const run: PendingRun = { runId, config, chat, projectContext, permission, workingChat, pendingApprovalIds: [], approvalCalls: {}, toolRounds: 0, progressWatchdog: freshWatchdogSnapshot() };
    this.recoverableRuns.set(run.runId, run);
    await this.persist();
    return this.runLoop(run);
  }

  async runStreaming(
    config: AIProviderConfig,
    chat: ChatRecord,
    projectContext: string | undefined,
    permission: PermissionLevel,
    emit: StreamEmitter,
    signal?: AbortSignal,
    runId: string = crypto.randomUUID(),
  ): Promise<AgentRunResult> {
    signal?.throwIfAborted();
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    const run: PendingRun = { runId, config, chat, projectContext, permission, workingChat, pendingApprovalIds: [], approvalCalls: {}, toolRounds: 0, progressWatchdog: freshWatchdogSnapshot(), streamEmitter: emit };
    this.recoverableRuns.set(run.runId, run);
    await this.persist();
    return this.runStreamLoop(run, signal);
  }

  async resumeRecovered(runId: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const run = this.recoverableRuns.get(runId);
    if (!run) throw new Error('Execução recuperável não encontrada.');
    if (run.pendingApprovalIds.length) throw new Error('A execução ainda possui aprovações pendentes.');
    return run.streamEmitter ? this.runStreamLoop(run, signal) : this.runLoop(run, signal);
  }

  async resume(approvalId: string, signal?: AbortSignal): Promise<AgentRunResult> {
    signal?.throwIfAborted();
    const pending = this.getPending(approvalId);
    const call = pending.approvalCalls[approvalId];
    if (!call) throw new Error('Chamada de ferramenta associada à aprovação não encontrada.');
    const approval = this.tools.listApprovals({ chatId: pending.chat.id, runId: pending.runId }).find((item) => item.id === approvalId);
    if (!approval) throw new Error('Aprovação não pertence à execução atual.');

    const result = await this.tools.approve(approvalId);
    signal?.throwIfAborted();
    if (!result.ok && result.error && /mudou desde a aprovação|não corresponde mais ao estado aprovado/i.test(result.error)) {
      if (pending.streamEmitter) {
        pending.streamEmitter({
          type: 'activity',
          chatId: pending.chat.id,
          runId: pending.runId,
          activity: {
            id: `approval_${Date.now()}`,
            runId: pending.runId,
            chatId: pending.chat.id,
            type: 'tool',
            message: `Aprovação mantida: ${call.name}`,
            status: 'failed',
            error: result.error,
            createdAt: Date.now(),
          },
        });
      }
      await this.persist();
      return this.pendingResult(pending, [approvalId]);
    }

    pending.workingChat.messages.push({
      role: 'tool',
      content: result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`,
      toolCallId: result.toolCallId,
      toolName: call.name,
      changes: result.changes,
      diffPlan: result.diffPlan,
      commandResult: result.commandResult,
      gitResult: result.gitResult,
      sources: result.sources,
      createdAt: Date.now(),
    });

    this.recordExternalDecision(pending, call, `approval:${approvalId}:${result.ok ? 'approved' : 'failed'}`);

    if (pending.streamEmitter) {
      pending.streamEmitter({
        type: 'activity',
        chatId: pending.chat.id,
        runId: pending.runId,
        activity: {
          id: `approval_${Date.now()}`,
          runId: pending.runId,
          chatId: pending.chat.id,
          type: 'tool',
          message: `Aprovado: ${call.name}`,
          status: result.ok ? 'success' : 'failed',
          commandResult: result.commandResult,
          gitResult: result.gitResult,
          changes: result.changes,
          diffPlan: result.diffPlan,
          error: result.error,
          createdAt: Date.now(),
        },
      });
    }

    return this.finishApproval(pending, approvalId, signal);
  }

  async reject(approvalId: string, signal?: AbortSignal): Promise<AgentRunResult> {
    signal?.throwIfAborted();
    const pending = this.getPending(approvalId);
    const call = pending.approvalCalls[approvalId];
    if (!call) throw new Error('Chamada de ferramenta associada à aprovação não encontrada.');
    const approval = this.tools.listApprovals({ chatId: pending.chat.id, runId: pending.runId }).find((item) => item.id === approvalId);
    if (!approval) throw new Error('Aprovação não pertence à execução atual.');

    this.tools.deny(approvalId);
    this.recordExternalDecision(pending, call, `approval:${approvalId}:denied`);
    pending.workingChat.messages.push({ role: 'tool', content: 'Operação recusada pelo usuário.', toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
    if (pending.streamEmitter) {
      pending.streamEmitter({
        type: 'activity',
        chatId: pending.chat.id,
        runId: pending.runId,
        activity: {
          id: `approval_${Date.now()}`,
          runId: pending.runId,
          chatId: pending.chat.id,
          type: 'tool',
          message: `Recusado: ${call.name}`,
          status: 'failed',
          createdAt: Date.now(),
        },
      });
    }
    signal?.throwIfAborted();
    return this.finishApproval(pending, approvalId, signal);
  }

  async cancelChat(chatId: string): Promise<void> {
    const runIds = new Set<string>();
    for (const run of this.recoverableRuns.values()) if (run.chat.id === chatId) runIds.add(run.runId);
    for (const run of this.pendingRuns.values()) if (run.chat.id === chatId) runIds.add(run.runId);
    for (const runId of runIds) this.recoverableRuns.delete(runId);
    for (const [approvalId, run] of this.pendingRuns) if (run.chat.id === chatId) this.pendingRuns.delete(approvalId);
    await this.persist();
  }

  private getPending(approvalId: string): PendingRun {
    const pending = this.pendingRuns.get(approvalId);
    if (!pending) throw new Error('Aprovação não encontrada ou já processada.');
    return pending;
  }

  private pendingResult(pending: PendingRun, ids = pending.pendingApprovalIds): AgentRunResult {
    return {
      chatId: pending.chat.id,
      response: { content: '', model: pending.workingChat.model, providerId: pending.workingChat.providerId },
      toolRounds: pending.toolRounds,
      pendingApprovalIds: [...ids],
      messages: [...pending.workingChat.messages],
    };
  }

  private async finishApproval(pending: PendingRun, approvalId: string, signal?: AbortSignal): Promise<AgentRunResult> {
    pending.pendingApprovalIds = pending.pendingApprovalIds.filter((id) => id !== approvalId);
    delete pending.approvalCalls[approvalId];
    this.pendingRuns.delete(approvalId);

    if (pending.pendingApprovalIds.length) {
      await this.persist();
      return this.pendingResult(pending);
    }

    pending.lastError = undefined;
    this.recoverableRuns.set(pending.runId, pending);
    await this.persist();
    signal?.throwIfAborted();
    return pending.streamEmitter ? this.runStreamLoop(pending, signal) : this.runLoop(pending, signal);
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const uniqueRuns = new Map<string, PendingRun>();
    for (const run of this.recoverableRuns.values()) uniqueRuns.set(run.runId, run);
    for (const run of this.pendingRuns.values()) uniqueRuns.set(run.runId, run);
    const state: PersistedAgentState = {
      version: 3,
      runs: [...uniqueRuns.values()].map((run) => ({
        runId: run.runId,
        config: run.config,
        chat: run.chat,
        projectContext: run.projectContext,
        permission: run.permission,
        workingChat: run.workingChat,
        pendingApprovalIds: [...run.pendingApprovalIds],
        approvalCalls: { ...run.approvalCalls },
        toolRounds: run.toolRounds,
        progressWatchdog: run.progressWatchdog,
        replanPending: run.replanPending,
        lastError: run.lastError,
      })),
      approvals: this.tools.listApprovals(),
    };
    const write = this.persistenceWrite.then(() => this.storage!.write(STATE_FILE, state));
    this.persistenceWrite = write.catch(() => {});
    await write;
  }

  private effectiveProjectContext(run: PendingRun): string | undefined {
    if (!run.replanPending) return run.projectContext;
    return [run.projectContext?.trim(), WATCHDOG_REPLAN_CONTEXT].filter(Boolean).join('\n\n') || WATCHDOG_REPLAN_CONTEXT;
  }

  private consumeReplanDirective(run: PendingRun): void {
    if (run.replanPending) run.replanPending = false;
  }

  private observeProgress(
    run: PendingRun,
    calls: AIToolCall[],
    results: AIToolResult[],
    emit?: StreamEmitter,
  ): ProgressWatchdogDecision {
    const watchdog = new ProgressWatchdog();
    watchdog.restore(run.progressWatchdog);
    const signals = results.flatMap((result, index) => progressSignalsFor(calls[index] ?? {
      id: result.toolCallId,
      name: 'read_file',
      input: {},
    }, result));
    const decision = watchdog.observe({
      calls: calls.map((call) => ({ name: call.name, input: call.input })),
      signals,
    });
    run.progressWatchdog = watchdog.snapshot();

    if (decision.action === 'replan') {
      run.replanPending = true;
      const message = 'O agente detectou estagnação e vai replanejar a estratégia.';
      const activity = { runId: run.runId, chatId: run.chat.id, type: 'thought' as const, message, status: 'running' as const };
      this.activity.emit(activity);
      if (emit) emit({ type: 'activity', chatId: run.chat.id, runId: run.runId, activity });
    }

    return decision;
  }

  private recordExternalDecision(run: PendingRun, call: AIToolCall, key: string): void {
    const watchdog = new ProgressWatchdog();
    watchdog.restore(run.progressWatchdog);
    watchdog.observe({
      calls: [{ name: call.name, input: call.input }],
      signals: [{ kind: 'result', key }],
    });
    run.progressWatchdog = watchdog.snapshot();
  }

  private async enforceWatchdogDecision(
    run: PendingRun,
    decision: ProgressWatchdogDecision,
    emit?: StreamEmitter,
  ): Promise<void> {
    if (decision.action !== 'stop_loop') return;
    const message = 'O agente entrou em um ciclo sem progresso mesmo após replanejamento.';
    run.lastError = message;
    const activity = { runId: run.runId, chatId: run.chat.id, type: 'error' as const, message, status: 'failed' as const, error: message };
    this.activity.emit(activity);
    if (emit) emit({ type: 'activity', chatId: run.chat.id, runId: run.runId, activity });
    this.recoverableRuns.delete(run.runId);
    await this.persist();
    throw new Error(message);
  }

  private appendToolResult(chat: ChatRecord, call: AIToolCall, result: Awaited<ReturnType<ToolRuntime['execute']>>): void {
    if (result.pendingApproval) return;
    const content = result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`;
    chat.messages.push({
      role: 'tool',
      content,
      toolCallId: call.id,
      toolName: call.name,
      changes: result.changes,
      diffPlan: result.diffPlan,
      commandResult: result.commandResult,
      gitResult: result.gitResult,
      sources: result.sources,
      createdAt: Date.now(),
    });
  }

  private emitToolActivity(runId: string, chatId: string, call: AIToolCall, result: Awaited<ReturnType<ToolRuntime['execute']>>, emit?: StreamEmitter): void {
    const snapshot = createToolActivitySnapshot(runId, call.id, call.name, result);
    const activityInput = { ...toActivityInput(snapshot), chatId, runId };
    this.activity.emit({ ...activityInput });
    if (emit) emit({ type: 'activity', chatId, runId, activity: { id: `tool_${call.id}`, createdAt: Date.now(), ...activityInput } });
  }

  private async runLoop(run: PendingRun, signal?: AbortSignal): Promise<AgentRunResult> {
    while (true) {
      signal?.throwIfAborted();
      let response: AIResponse;
      try {
        response = await this.chatRuntime.send(run.config, run.workingChat, this.effectiveProjectContext(run), signal);
        this.consumeReplanDirective(run);
        run.lastError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.lastError = message;
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'error', message, status: 'failed', error: message });
        await this.persist();
        throw error;
      }

      signal?.throwIfAborted();
      if (!response.toolCalls?.length) {
        run.workingChat.messages.push({ role: 'assistant', content: response.content, sources: response.sources, createdAt: Date.now() });
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'complete', message: 'Execução concluída.', status: 'success' });
        this.recoverableRuns.delete(run.runId);
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds: [], messages: [...run.workingChat.messages] };
      }

      const executionProjectId = run.workingChat.projectId || SYSTEM_PROJECT_ID;
      run.toolRounds += 1;
      this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      run.workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, sources: response.sources, createdAt: Date.now() });
      await this.persist();

      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      const pendingApprovalSignatures = new Map<string, string>();
      const roundResults: AIToolResult[] = [];
      const roundResults: AIToolResult[] = [];
      for (const call of response.toolCalls) {
        signal?.throwIfAborted();
        const signature = toolCallSignature(call);
        const duplicateApprovalId = pendingApprovalSignatures.get(signature);
        const result = duplicateApprovalId
          ? duplicatePendingApprovalResult(call, duplicateApprovalId)
          : await this.tools.execute(run.chat.id, executionProjectId, run.permission, call, run.runId);
        signal?.throwIfAborted();
        this.appendToolResult(run.workingChat, call, result);
        this.emitToolActivity(run.runId, run.chat.id, call, result);
        roundResults.push(result);
        if (result.pendingApproval && result.approvalId) {
          pendingApprovalIds.push(result.approvalId);
          approvalCalls[result.approvalId] = call;
          pendingApprovalSignatures.set(signature, result.approvalId);
        }
        await this.persist();
      }

      if (pendingApprovalIds.length) {
        const completedResults = roundResults.filter((result) => !result.pendingApproval);
        if (completedResults.length && completedResults.some((result, index) => progressSignalsFor(response.toolCalls![index] ?? response.toolCalls![0], result).length > 0)) {
          const completedCalls = response.toolCalls.filter((_, index) => !roundResults[index]?.pendingApproval);
          const decision = this.observeProgress(run, completedCalls, completedResults);
          await this.enforceWatchdogDecision(run, decision);
        }
        run.pendingApprovalIds = pendingApprovalIds;
        run.approvalCalls = approvalCalls;
        this.recoverableRuns.delete(run.runId);
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, run);
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        await this.persist();
        return this.pendingResult(run);
      }

      const watchdogDecision = this.observeProgress(run, response.toolCalls, roundResults);
      await this.enforceWatchdogDecision(run, watchdogDecision);
      this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'complete', message: `Ciclo de ferramentas ${run.toolRounds} concluído.`, status: 'success' });
      await this.persist();
    }
  }

  private async runStreamLoop(run: PendingRun, signal?: AbortSignal): Promise<AgentRunResult> {
    const emit = run.streamEmitter;
    if (!emit) throw new Error('Emitter de streaming não configurado.');

    while (true) {
      signal?.throwIfAborted();
      let response: AIResponse | undefined;
      let streamError: string | undefined;

      for await (const event of this.chatRuntime.stream(run.config, run.workingChat, this.effectiveProjectContext(run), signal)) {
        signal?.throwIfAborted();
        const contextualEvent: AIStreamEvent = {
          ...event,
          chatId: run.chat.id,
          runId: run.runId,
          activity: event.activity ? { ...event.activity, chatId: run.chat.id, runId: run.runId } : event.activity,
        };
        if (event.type === 'complete' && event.response) {
          response = event.response;
          if (event.response.toolCalls?.length) {
            if (event.usage) emit({ type: 'usage', chatId: run.chat.id, runId: run.runId, usage: event.usage });
            continue;
          }
        }
        if (event.type === 'error') streamError = event.error || 'Erro durante o streaming.';
        emit(contextualEvent);
      }

      if (streamError) {
        run.lastError = streamError;
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'error', message: streamError, status: 'failed', error: streamError });
        await this.persist();
        throw new Error(streamError);
      }
      if (!response) {
        run.lastError = 'O provider encerrou o streaming sem uma resposta final.';
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'error', message: run.lastError, status: 'failed', error: run.lastError });
        await this.persist();
        throw new Error(run.lastError);
      }

      this.consumeReplanDirective(run);
      run.lastError = undefined;
      if (!response.toolCalls?.length) {
        run.workingChat.messages.push({ role: 'assistant', content: response.content, sources: response.sources, createdAt: Date.now() });
        const completion: AIStreamEvent = {
          type: 'activity',
          chatId: run.chat.id,
          runId: run.runId,
          activity: { runId: run.runId, chatId: run.chat.id, type: 'complete', message: 'Execução concluída.', status: 'success' },
        };
        this.activity.emit(completion.activity!);
        emit(completion);
        this.recoverableRuns.delete(run.runId);
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds: [], messages: [...run.workingChat.messages] };
      }

      const executionProjectId = run.workingChat.projectId || SYSTEM_PROJECT_ID;
      run.toolRounds += 1;
      const roundActivity: AIStreamEvent = {
        type: 'activity',
        chatId: run.chat.id,
        runId: run.runId,
        activity: { runId: run.runId, chatId: run.chat.id, type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' },
      };
      this.activity.emit(roundActivity.activity!);
      emit(roundActivity);
      run.workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, sources: response.sources, createdAt: Date.now() });
      await this.persist();

      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      const pendingApprovalSignatures = new Map<string, string>();
      for (const call of response.toolCalls) {
        signal?.throwIfAborted();
        const signature = toolCallSignature(call);
        const duplicateApprovalId = pendingApprovalSignatures.get(signature);
        const result = duplicateApprovalId
          ? duplicatePendingApprovalResult(call, duplicateApprovalId)
          : await this.tools.execute(run.chat.id, executionProjectId, run.permission, call, run.runId);
        signal?.throwIfAborted();
        this.appendToolResult(run.workingChat, call, result);
        this.emitToolActivity(run.runId, run.chat.id, call, result, emit);
        roundResults.push(result);
        if (result.pendingApproval && result.approvalId) {
          pendingApprovalIds.push(result.approvalId);
          approvalCalls[result.approvalId] = call;
          pendingApprovalSignatures.set(signature, result.approvalId);
        }
        await this.persist();
      }

      if (pendingApprovalIds.length) {
        const completedResults = roundResults.filter((result) => !result.pendingApproval);
        if (completedResults.length && completedResults.some((result, index) => progressSignalsFor(response.toolCalls![index] ?? response.toolCalls![0], result).length > 0)) {
          const completedCalls = response.toolCalls.filter((_, index) => !roundResults[index]?.pendingApproval);
          const decision = this.observeProgress(run, completedCalls, completedResults, emit);
          await this.enforceWatchdogDecision(run, decision, emit);
        }
        run.pendingApprovalIds = pendingApprovalIds;
        run.approvalCalls = approvalCalls;
        this.recoverableRuns.delete(run.runId);
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, run);
        const approvalActivity: AIStreamEvent = {
          type: 'activity',
          chatId: run.chat.id,
          runId: run.runId,
          activity: { runId: run.runId, chatId: run.chat.id, type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' },
        };
        this.activity.emit(approvalActivity.activity!);
        emit(approvalActivity);
        emit({ type: 'approval_required', chatId: run.chat.id, runId: run.runId, pendingApprovalIds: [...pendingApprovalIds] });
        await this.persist();
        return this.pendingResult(run);
      }

      const watchdogDecision = this.observeProgress(run, response.toolCalls, roundResults, emit);
      await this.enforceWatchdogDecision(run, watchdogDecision, emit);
      this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'complete', message: `Ciclo de ferramentas ${run.toolRounds} concluído.`, status: 'success' });
      await this.persist();
    }
  }
}
