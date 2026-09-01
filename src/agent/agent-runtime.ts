import crypto from 'node:crypto';
import type { AIMessage, AIProviderConfig, AIResponse, AIStreamEvent, AIToolCall, ApprovalRequest, ChatRecord, PermissionLevel } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ToolRuntime } from './tool-runtime';
import { ChatRuntime } from '../ai/chat-runtime';
import { createToolActivitySnapshot, toActivityInput } from './tool-activity-bridge';

const MAX_TOOL_ROUNDS = 12;
const STATE_FILE = 'agent-runs.json';
type StreamEmitter = (event: AIStreamEvent) => void;

export interface AgentStateStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
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
}

interface PersistedAgentState {
  version: 2;
  runs: PersistedPendingRun[];
  approvals: ApprovalRequest[];
}

export interface AgentRunResult {
  chatId: string;
  response: AIResponse;
  toolRounds: number;
  pendingApprovalIds: string[];
  messages: AIMessage[];
}

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
    const stored = await this.storage.read<PersistedAgentState | { version: 1; runs: PersistedPendingRun[]; approvals: ApprovalRequest[] }>(STATE_FILE, { version: 2, runs: [], approvals: [] });
    if (!stored || !Array.isArray(stored.runs) || !Array.isArray(stored.approvals)) return;
    this.tools.restoreApprovals(stored.approvals);
    this.pendingRuns.clear();
    this.recoverableRuns.clear();
    const approvals = this.tools.listApprovals();
    for (const run of stored.runs) {
      if (!run.chat?.id || !Array.isArray(run.pendingApprovalIds) || !Array.isArray(run.workingChat?.messages)) continue;
      const runId = run.runId || crypto.randomUUID();
      const validIds = run.pendingApprovalIds.filter((id) => Boolean(run.approvalCalls?.[id]) && Boolean(approvals.find((approval) => approval.id === id)));
      const pending: PendingRun = { ...run, runId, pendingApprovalIds: validIds };
      if (validIds.length) {
        for (const id of validIds) this.pendingRuns.set(id, pending);
      } else {
        this.recoverableRuns.set(runId, pending);
      }
    }
    await this.persist();
  }

  hasPendingForChat(chatId: string): boolean {
    for (const pending of this.pendingRuns.values()) if (pending.chat.id === chatId) return true;
    return false;
  }

  listRecoverableRuns(): Array<{ runId: string; chatId: string; toolRounds: number }> {
    return [...this.recoverableRuns.values()].map((run) => ({ runId: run.runId, chatId: run.chat.id, toolRounds: run.toolRounds }));
  }

  async run(config: AIProviderConfig, chat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    const runId = crypto.randomUUID();
    const run: PendingRun = { runId, config, chat, projectContext, permission, workingChat, pendingApprovalIds: [], approvalCalls: {}, toolRounds: 0 };
    this.recoverableRuns.set(runId, run);
    await this.persist();
    return this.runLoop(run);
  }

  async runStreaming(config: AIProviderConfig, chat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel, emit: StreamEmitter): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    const runId = crypto.randomUUID();
    const run: PendingRun = { runId, config, chat, projectContext, permission, workingChat, pendingApprovalIds: [], approvalCalls: {}, toolRounds: 0, streamEmitter: emit };
    this.recoverableRuns.set(runId, run);
    await this.persist();
    return this.runStreamLoop(run);
  }

  async resumeRecovered(runId: string): Promise<AgentRunResult> {
    const run = this.recoverableRuns.get(runId);
    if (!run) throw new Error('Execução recuperável não encontrada.');
    if (run.pendingApprovalIds.length) throw new Error('A execução ainda possui aprovações pendentes.');
    return run.streamEmitter ? this.runStreamLoop(run) : this.runLoop(run);
  }

  async resume(approvalId: string): Promise<AgentRunResult> {
    const pending = this.getPending(approvalId);
    const call = pending.approvalCalls[approvalId];
    if (!call) throw new Error('Chamada de ferramenta associada à aprovação não encontrada.');
    const result = await this.tools.approve(approvalId);
    if (result.pendingApproval) {
      if (pending.streamEmitter) pending.streamEmitter({ type: 'activity', activity: { id: `approval_${Date.now()}`, type: 'tool', message: `Aprovação mantida: ${call.name}`, status: 'failed', createdAt: Date.now() } });
      await this.persist();
      return { chatId: pending.chat.id, response: { content: '', model: pending.workingChat.model, providerId: pending.workingChat.providerId }, toolRounds: pending.toolRounds, pendingApprovalIds: [approvalId], messages: [...pending.workingChat.messages] };
    }
    pending.workingChat.messages.push({ role: 'tool', content: result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`, toolCallId: result.toolCallId, toolName: call.name, changes: result.changes, diffPlan: result.diffPlan, commandResult: result.commandResult, gitResult: result.gitResult, createdAt: Date.now() });
    if (pending.streamEmitter) pending.streamEmitter({ type: 'activity', activity: { id: `approval_${Date.now()}`, type: 'tool', message: `Aprovado: ${call.name}`, status: result.ok ? 'success' : 'failed', commandResult: result.commandResult, gitResult: result.gitResult, changes: result.changes, diffPlan: result.diffPlan, error: result.error, createdAt: Date.now() } });
    return this.finishApproval(pending, approvalId);
  }

  async reject(approvalId: string): Promise<AgentRunResult> {
    const pending = this.getPending(approvalId);
    const call = pending.approvalCalls[approvalId];
    if (!call) throw new Error('Chamada de ferramenta associada à aprovação não encontrada.');
    if (!this.tools.deny(approvalId)) throw new Error('Aprovação não encontrada ou já processada.');
    pending.workingChat.messages.push({ role: 'tool', content: 'Operação recusada pelo usuário.', toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
    if (pending.streamEmitter) pending.streamEmitter({ type: 'activity', activity: { id: `approval_${Date.now()}`, type: 'tool', message: `Recusado: ${call.name}`, status: 'failed', createdAt: Date.now() } });
    return this.finishApproval(pending, approvalId);
  }

  private getPending(approvalId: string): PendingRun {
    const pending = this.pendingRuns.get(approvalId);
    if (!pending) throw new Error('Aprovação não encontrada ou já processada.');
    return pending;
  }

  private async finishApproval(pending: PendingRun, approvalId: string): Promise<AgentRunResult> {
    pending.pendingApprovalIds = pending.pendingApprovalIds.filter((id) => id !== approvalId);
    delete pending.approvalCalls[approvalId];
    this.pendingRuns.delete(approvalId);
    if (pending.pendingApprovalIds.length) {
      await this.persist();
      return { chatId: pending.chat.id, response: { content: '', model: pending.workingChat.model, providerId: pending.workingChat.providerId }, toolRounds: pending.toolRounds, pendingApprovalIds: [...pending.pendingApprovalIds], messages: [...pending.workingChat.messages] };
    }
    this.recoverableRuns.set(pending.runId, pending);
    await this.persist();
    return pending.streamEmitter ? this.runStreamLoop(pending) : this.runLoop(pending);
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
      })),
      approvals: this.tools.listApprovals(),
    };
    const write = this.persistenceWrite.then(() => this.storage!.write(STATE_FILE, state));
    this.persistenceWrite = write.catch(() => undefined);
    await write;
  }

  private appendToolResult(chat: ChatRecord, call: AIToolCall, result: Awaited<ReturnType<ToolRuntime['execute']>>): void {
    const content = result.pendingApproval ? 'Operação aguardando aprovação do usuário.' : result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`;
    chat.messages.push({ role: 'tool', content, toolCallId: call.id, toolName: call.name, changes: result.changes, diffPlan: result.diffPlan, commandResult: result.commandResult, gitResult: result.gitResult, createdAt: Date.now() });
  }

  private emitToolActivity(call: AIToolCall, result: Awaited<ReturnType<ToolRuntime['execute']>>, emit?: StreamEmitter): void {
    const snapshot = createToolActivitySnapshot(call.id, call.name, result);
    const activityInput = toActivityInput(snapshot);
    this.activity.emit({ id: `tool_${call.id}`, createdAt: Date.now(), ...activityInput });
    if (emit) emit({ type: 'activity', activity: { id: `tool_${call.id}`, createdAt: Date.now(), ...activityInput } });
  }

  private async runLoop(run: PendingRun): Promise<AgentRunResult> {
    while (run.toolRounds < MAX_TOOL_ROUNDS) {
      const response = await this.chatRuntime.send(run.config, run.workingChat, run.projectContext);
      if (!response.toolCalls?.length) {
        run.workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
        this.recoverableRuns.delete(run.runId);
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds: [], messages: [...run.workingChat.messages] };
      }
      if (!run.workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      run.toolRounds += 1;
      this.activity.emit({ type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      run.workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      await this.persist();
      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      for (const call of response.toolCalls) {
        const result = await this.tools.execute(run.workingChat.projectId, run.permission, call);
        this.appendToolResult(run.workingChat, call, result);
        this.emitToolActivity(call, result);
        if (result.pendingApproval && result.approvalId) { pendingApprovalIds.push(result.approvalId); approvalCalls[result.approvalId] = call; }
        await this.persist();
      }
      if (pendingApprovalIds.length) {
        run.pendingApprovalIds = pendingApprovalIds;
        run.approvalCalls = approvalCalls;
        this.recoverableRuns.delete(run.runId);
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, run);
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds, messages: [...run.workingChat.messages] };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${run.toolRounds} concluído.`);
      await this.persist();
    }
    this.recoverableRuns.delete(run.runId);
    await this.persist();
    throw new Error('O agente atingiu o limite de ciclos de ferramentas.');
  }

  private async runStreamLoop(run: PendingRun): Promise<AgentRunResult> {
    const emit = run.streamEmitter;
    if (!emit) throw new Error('Emitter de streaming não configurado.');
    while (run.toolRounds < MAX_TOOL_ROUNDS) {
      let response: AIResponse | undefined;
      let streamError: string | undefined;
      for await (const event of this.chatRuntime.stream(run.config, run.workingChat, run.projectContext)) {
        if (event.type === 'complete' && event.response) response = event.response;
        if (event.type === 'error') streamError = event.error || 'Erro durante o streaming.';
        emit(event);
      }
      if (streamError) throw new Error(streamError);
      if (!response) throw new Error('O provider encerrou o streaming sem uma resposta final.');
      if (!response.toolCalls?.length) {
        run.workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
        this.recoverableRuns.delete(run.runId);
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds: [], messages: [...run.workingChat.messages] };
      }
      if (!run.workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      run.toolRounds += 1;
      run.workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      await this.persist();
      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      for (const call of response.toolCalls) {
        const result = await this.tools.execute(run.workingChat.projectId, run.permission, call);
        this.appendToolResult(run.workingChat, call, result);
        this.emitToolActivity(call, result, emit);
        if (result.pendingApproval && result.approvalId) { pendingApprovalIds.push(result.approvalId); approvalCalls[result.approvalId] = call; }
        await this.persist();
      }
      if (pendingApprovalIds.length) {
        run.pendingApprovalIds = pendingApprovalIds;
        run.approvalCalls = approvalCalls;
        this.recoverableRuns.delete(run.runId);
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, run);
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        emit({ type: 'approval_required', pendingApprovalIds: [...pendingApprovalIds] });
        await this.persist();
        return { chatId: run.chat.id, response, toolRounds: run.toolRounds, pendingApprovalIds, messages: [...run.workingChat.messages] };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${run.toolRounds} concluído.`);
      await this.persist();
    }
    this.recoverableRuns.delete(run.runId);
    await this.persist();
    throw new Error('O agente atingiu o limite de ciclos de ferramentas.');
  }
}