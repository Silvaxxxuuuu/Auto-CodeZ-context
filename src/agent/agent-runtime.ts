import type { AIMessage, AIProviderConfig, AIResponse, AIToolCall, ChatRecord, PermissionLevel } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ToolRuntime } from './tool-runtime';
import { ChatRuntime } from '../ai/chat-runtime';

const MAX_TOOL_ROUNDS = 12;

type PendingRun = {
  config: AIProviderConfig;
  chat: ChatRecord;
  projectContext?: string;
  permission: PermissionLevel;
  workingChat: ChatRecord;
  pendingApprovalIds: string[];
  approvalCalls: Record<string, AIToolCall>;
};

export interface AgentRunResult {
  chatId: string;
  response: AIResponse;
  toolRounds: number;
  pendingApprovalIds: string[];
  messages: AIMessage[];
}

export class AgentRuntime {
  private readonly pendingRuns = new Map<string, PendingRun>();

  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly tools: ToolRuntime,
    private readonly activity = new ActivityRuntime(),
  ) {}

  async run(config: AIProviderConfig, chat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    return this.runLoop(config, chat, workingChat, projectContext, permission, 0);
  }

  async resume(approvalId: string): Promise<AgentRunResult> {
    const pending = this.getPending(approvalId);
    const call = pending.approvalCalls[approvalId];
    if (!call) throw new Error('Chamada de ferramenta associada à aprovação não encontrada.');
    const result = await this.tools.approve(approvalId);
    pending.workingChat.messages.push({
      role: 'tool',
      content: result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`,
      toolCallId: result.toolCallId,
      toolName: call.name,
      changes: result.changes,
      createdAt: Date.now(),
    });
    return this.finishApproval(pending, approvalId);
  }

  async reject(approvalId: string): Promise<AgentRunResult> {
    const pending = this.getPending(approvalId);
    const call = pending.approvalCalls[approvalId];
    if (!call) throw new Error('Chamada de ferramenta associada à aprovação não encontrada.');
    if (!this.tools.deny(approvalId)) throw new Error('Aprovação não encontrada ou já processada.');
    pending.workingChat.messages.push({ role: 'tool', content: 'Operação recusada pelo usuário.', toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
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
      return {
        chatId: pending.chat.id,
        response: { content: '', model: pending.workingChat.model, providerId: pending.workingChat.providerId },
        toolRounds: 0,
        pendingApprovalIds: [...pending.pendingApprovalIds],
        messages: [...pending.workingChat.messages],
      };
    }
    return this.runLoop(pending.config, pending.chat, pending.workingChat, pending.projectContext, pending.permission, 0);
  }

  private async runLoop(config: AIProviderConfig, chat: ChatRecord, workingChat: ChatRecord, projectContext: string | undefined, permission: PermissionLevel, toolRounds: number): Promise<AgentRunResult> {
    while (true) {
      const response = await this.chatRuntime.send(config, workingChat, projectContext);
      if (!response.toolCalls?.length) {
        workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
        return { chatId: chat.id, response, toolRounds, pendingApprovalIds: [], messages: [...workingChat.messages] };
      }
      if (!workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      if (toolRounds >= MAX_TOOL_ROUNDS) throw new Error('O agente atingiu o limite de ciclos de ferramentas.');

      toolRounds += 1;
      this.activity.emit({ type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      const pendingApprovalIds: string[] = [];
      const approvalCalls: Record<string, AIToolCall> = {};

      for (const call of response.toolCalls) {
        const result = await this.tools.execute(workingChat.projectId, permission, call);
        if (result.pendingApproval && result.approvalId) {
          pendingApprovalIds.push(result.approvalId);
          approvalCalls[result.approvalId] = call;
          continue;
        }
        const content = result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`;
        workingChat.messages.push({ role: 'tool', content, toolCallId: call.id, toolName: call.name, changes: result.changes, createdAt: Date.now() });
      }

      if (pendingApprovalIds.length) {
        const pendingRun: PendingRun = { config, chat, projectContext, permission, workingChat, pendingApprovalIds, approvalCalls };
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, pendingRun);
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        return { chatId: chat.id, response, toolRounds, pendingApprovalIds, messages: [...workingChat.messages] };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${toolRounds} concluído.`);
    }
  }
}