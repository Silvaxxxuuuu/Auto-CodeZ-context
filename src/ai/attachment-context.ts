import type { AIAttachment, AIAttachmentContext, AIMessage, Capability } from './types';

export type AttachmentDelivery =
  | { mode: 'native'; attachment: AIAttachment }
  | { mode: 'text'; attachment: AIAttachment; text: string };

function bestDerivedContext(contexts: AIAttachmentContext[] | undefined): string | undefined {
  if (!contexts?.length) return undefined;
  const priority: AIAttachmentContext['kind'][] = ['text', 'ocr', 'caption', 'transcript', 'metadata'];
  for (const kind of priority) {
    const candidate = contexts.find((context) => context.kind === kind && context.text.trim());
    if (candidate) return candidate.text.trim();
  }
  return undefined;
}

function attachmentLabel(attachment: AIAttachment): string {
  return `[Anexo: ${attachment.name} · ${attachment.mediaType} · ${attachment.size} bytes]`;
}

export function resolveAttachmentDelivery(
  attachment: AIAttachment,
  capabilities: readonly Capability[],
): AttachmentDelivery {
  if (attachment.kind === 'image' && capabilities.includes('vision')) {
    return { mode: 'native', attachment };
  }

  const derived = bestDerivedContext(attachment.contexts);
  if (derived) {
    return {
      mode: 'text',
      attachment,
      text: `${attachmentLabel(attachment)}\n${derived}`,
    };
  }

  return {
    mode: 'text',
    attachment,
    text: `${attachmentLabel(attachment)}\nConteúdo do anexo ainda não foi indexado pelo Auto CodeZ.`,
  };
}

export function attachmentFallbackContext(
  attachments: readonly AIAttachment[] | undefined,
  capabilities: readonly Capability[],
): string {
  if (!attachments?.length) return '';
  return attachments
    .map((attachment) => resolveAttachmentDelivery(attachment, capabilities))
    .filter((delivery): delivery is Extract<AttachmentDelivery, { mode: 'text' }> => delivery.mode === 'text')
    .map((delivery) => delivery.text)
    .join('\n\n');
}


export function prepareMessagesForAttachments(
  messages: readonly AIMessage[],
  capabilities: readonly Capability[],
): AIMessage[] {
  return messages.map((message) => {
    if (!message.attachments?.length) return { ...message };

    const nativeAttachments: AIAttachment[] = [];
    const fallback: string[] = [];
    for (const attachment of message.attachments) {
      const delivery = resolveAttachmentDelivery(attachment, capabilities);
      if (delivery.mode === 'native') nativeAttachments.push({ ...delivery.attachment });
      else fallback.push(delivery.text);
    }

    const suffix = fallback.length
      ? `\n\n--- Contexto de anexos indexado pelo Auto CodeZ ---\n${fallback.join('\n\n')}`
      : '';
    return {
      ...message,
      content: `${message.content}${suffix}`,
      ...(nativeAttachments.length ? { attachments: nativeAttachments } : {}),
    };
  });
}
