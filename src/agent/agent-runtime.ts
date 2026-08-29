import type { AIProviderConfig, AIResponse, ChatRecord, PermissionLevel } from '../ai/types';
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
};

export interface AgentRunResult {
  response: AIResponse;
  toolRounds: number;
  pendingApprovalIds: string[];
}

export class AgentRuntime {
  private readonly pendingRuns = new Map<string, PendingRun>();

  constructor(
    private readonly chatRuntime: ChatRuntime,
    private readonly tools: ToolRuntime,
    private readonly activity = new ActivityRuntime(),
  ) {}

  async run(
    config: AIProviderConfig,
    chat: ChatRecord,
    projectContext: string | undefined,
    permission: PermissionLevel,
  ): Promise<AgentRunResult> {
    const workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    return this.runLoop(config, chat, workingChat, projectContext, permission, 0);
  }

  async resume(approvalId: string): Promise<AgentRunResult> {
    const pending = this.pendingRuns.get(approvalId);
    if (!pending) throw new Error('Aprovação não encontrada ou já processada.');

    const result = await this.tools.approve(approvalId);
    pending.workingChat.messages.push({
      role: 'tool',
      content: result.ok ? result.output || 'Operação concluída sem saída.' : `Falha: ${result.error || 'erro desconhecido'}`,
      toolCallId: result.toolCallId,
      createdAt: Date.now(),
    });
    pending.pendingApprovalIds = pending.pendingApprovalIds.filter((id) => id !== approvalId);
    this.pendingRuns.delete(approvalId);

    if (pending.pendingApprovalIds.length) {
      return {
        response: { content: '', model: pending.workingChat.model, providerId: pending.workingChat.providerId },
        toolRounds: 0,
        pendingApprovalIds: [...pending.pendingApprovalIds],
      };
    }

    return this.runLoop(
      pending.config,
      pending.chat,
      pending.workingChat,
      pending.projectContext,
      pending.permission,
      0,
    );
  }

  private async runLoop(
    config: AIProviderConfig,
    chat: ChatRecord,
    workingChat: ChatRecord,
    projectContext: string | undefined,
    permission: PermissionLevel,
    toolRounds: number,
  ): Promise<AgentRunResult> {
    while (true) {
      const response = await this.chatRuntime.send(config, workingChat, projectContext);
      if (!response.toolCalls?.length) return { response, toolRounds, pendingApprovalIds: [] };
      if (!workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      if (toolRounds >= MAX_TOOL_ROUNDS) throw new Error('O agente atingiu o limite de ciclos de ferramentas.');

      toolRounds += 1;
      this.activity.emit({ type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      workingChat.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() });
      const pendingApprovalIds: string[] = [];

      for (const call of response.toolCalls) {
        const result = await this.tools.execute(workingChat.projectId, permission, call);
        if (result.pendingApproval && result.approvalId) {
          pendingApprovalIds.push(result.approvalId);
          continue;
        }
        const content = result.ok
          ? result.output || 'Operação concluída sem saída.'
          : `Falha: ${result.error || 'erro desconhecido'}`;
        workingChat.messages.push({ role: 'tool', content, toolCallId: call.id, toolName: call.name, createdAt: Date.now() });
      }

      if (pendingApprovalIds.length) {
        const pendingRun: PendingRun = { config, chat, projectContext, permission, workingChat, pendingApprovalIds };
        for (const approvalId of pendingApprovalIds) this.pendingRuns.set(approvalId, pendingRun);
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        return { response, toolRounds, pendingApprovalIds };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${toolRounds} concluído.`);
    }
  }
}
