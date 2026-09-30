import type { ChatRecord } from './ai/types';
import type { ExecutionReport } from './execution-report';

export type SafeResponseRetry = {
  chat: ChatRecord;
  content: string;
  attachments: NonNullable<ChatRecord['messages'][number]['attachments']>;
};

export function prepareSafeResponseRetry(chat: ChatRecord, runId: string, report: ExecutionReport | null | undefined): SafeResponseRetry {
  if (!runId.trim()) throw new Error('Execução da resposta inválida.');
  if (!report || report.chatId !== chat.id || report.runId !== runId) {
    throw new Error('Não foi possível comprovar a execução associada a esta resposta.');
  }
  if (report.recordedTools.observed !== 0) {
    throw new Error('Tentar novamente ainda não é permitido para respostas que executaram ferramentas.');
  }

  let targetIndex = -1;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message.role === 'assistant' && message.runId === runId && !message.toolCalls?.length) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) throw new Error('Resposta final da execução não encontrada.');

  let userIndex = -1;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    if (chat.messages[index].role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) throw new Error('Mensagem do usuário associada à resposta não encontrada.');

  const between = chat.messages.slice(userIndex + 1, targetIndex);
  if (between.some((message) => message.role === 'tool' || Boolean(message.toolCalls?.length))) {
    throw new Error('Retry bloqueado porque a execução possui efeitos ou chamadas de ferramenta no histórico.');
  }
  if (between.some((message) => message.role === 'assistant' && message.runId && message.runId !== runId)) {
    throw new Error('Retry bloqueado porque outra execução já existe entre a pergunta e a resposta.');
  }

  const user = chat.messages[userIndex];
  const content = user.content.trim();
  if (!content) throw new Error('Mensagem original vazia.');
  const attachments = user.attachments ? user.attachments.map((attachment) => ({ ...attachment })) : [];
  return {
    chat: { ...chat, messages: chat.messages.slice(0, targetIndex).map((message) => ({ ...message })) },
    content,
    attachments,
  };
}
