import crypto from 'node:crypto';
import type { AIMessage, AIProviderConfig, AIResponse, AIStreamEvent, AIToolCall, ApprovalRequest, ChatRecord, PermissionLevel } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ToolRuntime } from './tool-runtime';
import { SYSTEM_PROJECT_ID } from './command-runtime';
import { ChatRuntime } from '../ai/chat-runtime';
import { createToolActivitySnapshot, toActivityInput } from './tool-activity-bridge';

const MAX_TOOL_ROUNDS = 12;
const STATE_FILE = 'agent-runs.json';

type StreamEmitter = (event: AIStreamEvent) => void;

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
  lastError?: string;
}

interface PersistedAgentState {
  version: 2;
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
    const stored = await this.storage.read<PersistedAgentState | { version: 1; runs: PersistedPendingRun[]; approvals: ApprovalRequest[] }>(
      STATE_FILE,
      { version: 2, runs: [], approvals: [] },
    );
    if (!stored || !Array.isArray(stored.runs) || !Array.isArray(stored.approvals)) return;

    this.pendingRuns.clear();
    this.recoverableRuns.clear();

    const normalizedRuns = stored.runs
      .filter((run) => run?.chat?.id && Array.isArray(run.pendingApprovalIds) && Array.isArray(run.workingChat?.messages))
      .map((run) => ({ ...run, runId: run.runId || crypto.randomUUID() }));

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
    const run: PendingRun = { runId, config, chat, projectContext, permission, workingChat, pendingApprovalIds: [], approvalCalls: {}, toolRounds: 0 };
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
    const run: PendingRun = { runId, config, chat, projectContext, permission, workingChat, pendingApprovalIds: [], approvalCalls: {}, toolRounds: 0, streamEmitter: emit };
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
      createdAt: Date.now(),
    });

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
      version: 2,
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
        lastError: run.lastError,
      })),
      approvals: this.tools.listApprovals(),
    };
    const write = this.persistenceWrite.then(() => this.storage!.write(STATE_FILE, state));
    this.persistenceWrite = write.catch(() => {});
    await write;
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
    while (run.toolRounds < MAX_TOOL_ROUNDS) {
      signal?.throwIfAborted();
      let response: AIResponse;
      try {
        response = await this.chatRuntime.send(run.config, run.workingChat, run.projectContext, signal);
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
        run.workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'complete', message: 'Execução concluída.', status: 'success' });
        this.recoverableRuns.delete(run.runId);
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds: [], messages: [...run.workingChat.messages] };
      }

      const executionProjectId = run.workingChat.projectId || SYSTEM_PROJECT_ID;
      run.toolRounds += 1;
      this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      run.workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      await this.persist();

      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      for (const call of response.toolCalls) {
        signal?.throwIfAborted();
        const result = await this.tools.execute(run.chat.id, executionProjectId, run.permission, call, run.runId);
        signal?.throwIfAborted();
        this.appendToolResult(run.workingChat, call, result);
        this.emitToolActivity(run.runId, run.chat.id, call, result);
        if (result.pendingApproval && result.approvalId) {
          pendingApprovalIds.push(result.approvalId);
          approvalCalls[result.approvalId] = call;
        }
        await this.persist();
      }

      if (pendingApprovalIds.length) {
        run.pendingApprovalIds = pendingApprovalIds;
        run.approvalCalls = approvalCalls;
        this.recoverableRuns.delete(run.runId);
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, run);
        this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        await this.persist();
        return this.pendingResult(run);
      }

      this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'complete', message: `Ciclo de ferramentas ${run.toolRounds} concluído.`, status: 'success' });
      await this.persist();
    }

    this.recoverableRuns.delete(run.runId);
    await this.persist();
    throw new Error('O agente atingiu o limite de ciclos de ferramentas.');
  }

  private async runStreamLoop(run: PendingRun, signal?: AbortSignal): Promise<AgentRunResult> {
    const emit = run.streamEmitter;
    if (!emit) throw new Error('Emitter de streaming não configurado.');

    while (run.toolRounds < MAX_TOOL_ROUNDS) {
      signal?.throwIfAborted();
      let response: AIResponse | undefined;
      let streamError: string | undefined;

      for await (const event of this.chatRuntime.stream(run.config, run.workingChat, run.projectContext, signal)) {
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

      run.lastError = undefined;
      if (!response.toolCalls?.length) {
        run.workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
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
      run.workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      await this.persist();

      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      for (const call of response.toolCalls) {
        signal?.throwIfAborted();
        const result = await this.tools.execute(run.chat.id, executionProjectId, run.permission, call, run.runId);
        signal?.throwIfAborted();
        this.appendToolResult(run.workingChat, call, result);
        this.emitToolActivity(run.runId, run.chat.id, call, result, emit);
        if (result.pendingApproval && result.approvalId) {
          pendingApprovalIds.push(result.approvalId);
          approvalCalls[result.approvalId] = call;
        }
        await this.persist();
      }

      if (pendingApprovalIds.length) {
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

      this.activity.emit({ runId: run.runId, chatId: run.chat.id, type: 'complete', message: `Ciclo de ferramentas ${run.toolRounds} concluído.`, status: 'success' });
      await this.persist();
    }

    this.recoverableRuns.delete(run.runId);
    await this.persist();
    throw new Error('O agente atingiu o limite de ciclos de ferramentas.');
  }
}
