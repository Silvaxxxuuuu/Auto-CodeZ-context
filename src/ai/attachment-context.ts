import type { AIAttachment, AIAttachmentContext, AIMessage, Capability } from './types';
import { isNativeImageMediaType } from './provider-attachments';

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
  if (
    attachment.kind === 'image'
    && capabilities.includes('vision')
    && isNativeImageMediaType(attachment.mediaType)
  ) {
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
  maximumDerivedChars = 120_000,
): AIMessage[] {
  let remaining = Math.max(4_000, Math.floor(maximumDerivedChars));
  const prepared = messages.map((message) => ({ ...message }));

  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    const message = prepared[index];
    if (!message.attachments?.length) continue;

    const nativeAttachments: AIAttachment[] = [];
    const fallback: string[] = [];
    for (const attachment of message.attachments) {
      const delivery = resolveAttachmentDelivery(attachment, capabilities);
      if (delivery.mode === 'native') {
        nativeAttachments.push({ ...delivery.attachment });
        continue;
      }

      if (remaining <= 0) continue;
      const full = delivery.text;
      const allowed = Math.min(full.length, remaining);
      if (allowed <= 0) continue;
      const clipped = allowed < full.length
        ? `${full.slice(0, Math.max(0, allowed - 96))}\n[... contexto do anexo truncado para caber na janela do modelo ...]`
        : full;
      fallback.push(clipped);
      remaining -= clipped.length;
    }

    const suffix = fallback.length
      ? `\n\n--- Contexto de anexos indexado pelo Auto CodeZ ---\n${fallback.join('\n\n')}`
      : '';
    prepared[index] = {
      ...message,
      content: `${message.content}${suffix}`,
      ...(nativeAttachments.length ? { attachments: nativeAttachments } : { attachments: undefined }),
    };
  }

  return prepared;
}
