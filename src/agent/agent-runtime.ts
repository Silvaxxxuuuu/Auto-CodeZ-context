import type { AIMessage, AIProviderConfig, AIResponse, AIStreamEvent, AIToolCall, ApprovalRequest, ChatRecord, PermissionLevel } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ToolRuntime } from './tool-runtime';
import { ChatRuntime } from '../ai/chat-runtime';

const MAX_TOOL_ROUNDS = 12;
const STATE_FILE = 'agent-runs.json';
type StreamEmitter = (event: AIStreamEvent) => void;

export interface AgentStateStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

type PendingRun = {
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
  version: 1;
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
  private persistenceWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly tools: ToolRuntime,
    private readonly activity = new ActivityRuntime(),
    private readonly storage?: AgentStateStorage,
  ) {}

  async init(): Promise<void> {
    if (!this.storage) return;
    const state = await this.storage.read<PersistedAgentState>(STATE_FILE, { version: 1, runs: [], approvals: [] });
    if (!state || state.version !== 1 || !Array.isArray(state.runs) || !Array.isArray(state.approvals)) return;
    this.tools.restoreApprovals(state.approvals);
    this.pendingRuns.clear();
    for (const run of state.runs) {
      if (!run.chat?.id || !Array.isArray(run.pendingApprovalIds) || !run.pendingApprovalIds.length) continue;
      const validIds = run.pendingApprovalIds.filter((id) => Boolean(run.approvalCalls?.[id]) && Boolean(this.tools.listApprovals().find((approval) => approval.id === id)));
      if (!validIds.length) continue;
      const pending: PendingRun = { ...run, pendingApprovalIds: validIds };
      for (const id of validIds) this.pendingRuns.set(id, pending);
    }
    await this.persist();
  }

  hasPendingForChat(chatId: string): boolean {
    for (const pending of this.pendingRuns.values()) if (pending.chat.id === chatId) return true;
    return false;
  }

  async run(config: AIProviderConfig, chat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    return this.runLoop(config, chat, workingChat, projectContext, permission, 0);
  }

  async runStreaming(config: AIProviderConfig, chat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel, emit: StreamEmitter): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    return this.runStreamLoop(config, chat, workingChat, projectContext, permission, 0, emit);
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
    pending.workingChat.messages.push({ role: 'tool', content: result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`, toolCallId: result.toolCallId, toolName: call.name, changes: result.changes, diffPlan: result.diffPlan, createdAt: Date.now() });
    if (pending.streamEmitter) pending.streamEmitter({ type: 'activity', activity: { id: `approval_${Date.now()}`, type: 'tool', message: `Aprovado: ${call.name}`, status: result.ok ? 'success' : 'failed', createdAt: Date.now() } });
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
    await this.persist();
    if (pending.streamEmitter) return this.runStreamLoop(pending.config, pending.chat, pending.workingChat, pending.projectContext, pending.permission, pending.toolRounds, pending.streamEmitter);
    return this.runLoop(pending.config, pending.chat, pending.workingChat, pending.projectContext, pending.permission, pending.toolRounds);
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const state: PersistedAgentState = {
      version: 1,
      runs: [...new Set(this.pendingRuns.values())].map((run) => ({
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
    chat.messages.push({ role: 'tool', content, toolCallId: call.id, toolName: call.name, changes: result.changes, diffPlan: result.diffPlan, createdAt: Date.now() });
  }

  private async runLoop(config: AIProviderConfig, chat: ChatRecord, workingChat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel, toolRounds: number): Promise<AgentRunResult> {
    while (toolRounds < MAX_TOOL_ROUNDS) {
      const response = await this.chatRuntime.send(config, workingChat, projectContext);
      if (!response.toolCalls?.length) {
        workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
        return { chatId: chat.id, response, toolRounds, pendingApprovalIds: [], messages: [...workingChat.messages] };
      }
      if (!workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      toolRounds += 1;
      this.activity.emit({ type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      for (const call of response.toolCalls) {
        const result = await this.tools.execute(workingChat.projectId, permission, call);
        this.appendToolResult(workingChat, call, result);
        if (result.pendingApproval && result.approvalId) { pendingApprovalIds.push(result.approvalId); approvalCalls[result.approvalId] = call; }
      }
      if (pendingApprovalIds.length) {
        const pendingRun: PendingRun = { config, chat, projectContext, permission, workingChat, pendingApprovalIds, approvalCalls, toolRounds };
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, pendingRun);
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        await this.persist();
        return { chatId: chat.id, response, toolRounds, pendingApprovalIds, messages: [...workingChat.messages] };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${toolRounds} concluído.`);
    }
    throw new Error('O agente atingiu o limite de ciclos de ferramentas.');
  }

  private async runStreamLoop(config: AIProviderConfig, chat: ChatRecord, workingChat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel, toolRounds: number, emit: StreamEmitter): Promise<AgentRunResult> {
    while (toolRounds < MAX_TOOL_ROUNDS) {
      let response: AIResponse | undefined;
      let streamError: string | undefined;
      for await (const event of this.chatRuntime.stream(config, workingChat, projectContext)) {
        if (event.type === 'complete' && event.response) response = event.response;
        if (event.type === 'error') streamError = event.error || 'Erro durante o streaming.';
        emit(event);
      }
      if (streamError) throw new Error(streamError);
      if (!response) throw new Error('O provider encerrou o streaming sem uma resposta final.');
      if (!response.toolCalls?.length) {
        workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
        return { chatId: chat.id, response, toolRounds, pendingApprovalIds: [], messages: [...workingChat.messages] };
      }
      if (!workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      toolRounds += 1;
      workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};
      for (const call of response.toolCalls) {
        const result = await this.tools.execute(workingChat.projectId, permission, call);
        this.appendToolResult(workingChat, call, result);
        if (result.pendingApproval && result.approvalId) { pendingApprovalIds.push(result.approvalId); approvalCalls[result.approvalId] = call; }
        else emit({ type: 'activity', activity: { id: `tool_${Date.now()}`, type: 'tool', message: result.ok ? `Concluído: ${call.name}` : `Falha: ${call.name}`, status: result.ok ? 'success' : 'failed', createdAt: Date.now() } });
      }
      if (pendingApprovalIds.length) {
        const pendingRun: PendingRun = { config, chat, projectContext, permission, workingChat, pendingApprovalIds, approvalCalls, toolRounds, streamEmitter: emit };
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, pendingRun);
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        emit({ type: 'approval_required', pendingApprovalIds: [...pendingApprovalIds] });
        await this.persist();
        return { chatId: chat.id, response, toolRounds, pendingApprovalIds, messages: [...workingChat.messages] };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${toolRounds} concluído.`);
    }
    throw new Error('O agente atingiu o limite de ciclos de ferramentas.');
  }
}
