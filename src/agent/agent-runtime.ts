import type { AIProviderConfig, AIResponse, ChatRecord, PermissionLevel } from '../ai/types';
import { ActivityRuntime } from './activity-runtime';
import { ToolRuntime } from './tool-runtime';
import { ChatRuntime } from '../ai/chat-runtime';

const MAX_TOOL_ROUNDS = 12;

export interface AgentRunResult {
  response: AIResponse;
  toolRounds: number;
  pendingApprovalIds: string[];
}

export class AgentRuntime {
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
    let workingChat: ChatRecord = { ...chat, messages: [...chat.messages] };
    let toolRounds = 0;

    while (true) {
      const response = await this.chatRuntime.send(config, workingChat, projectContext);
      if (!response.toolCalls?.length) return { response, toolRounds, pendingApprovalIds: [] };
      if (!workingChat.projectId) throw new Error('Uma ferramenta foi solicitada sem um projeto ativo.');
      if (toolRounds >= MAX_TOOL_ROUNDS) throw new Error('O agente atingiu o limite de ciclos de ferramentas.');

      toolRounds += 1;
      this.activity.emit({ type: 'tool', message: `Executando ${response.toolCalls.length} ferramenta(s).`, status: 'running' });
      workingChat.messages.push({ role: 'assistant', content: response.content, createdAt: Date.now() });
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
        this.activity.emit({ type: 'action', message: 'O agente aguarda aprovação antes de continuar.', status: 'pending' });
        return { response, toolRounds, pendingApprovalIds };
      }
      this.activity.success('tool', `Ciclo de ferramentas ${toolRounds} concluído.`);
    }
  }
}
