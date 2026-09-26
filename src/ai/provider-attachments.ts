import type { AIAttachment, AIMessage } from './types';

export function isNativeImageMediaType(mediaType: string): boolean {
  return /^image\/(?:png|jpeg|webp|gif)$/i.test(mediaType);
}

export function nativeImageAttachments(message: AIMessage): AIAttachment[] {
  return (message.attachments ?? []).filter((attachment) =>
    attachment.kind === 'image'
    && typeof attachment.dataBase64 === 'string'
    && attachment.dataBase64.length > 0
    && isNativeImageMediaType(attachment.mediaType),
  );
}

export function imageDataUrl(attachment: AIAttachment): string {
  if (!attachment.dataBase64) throw new Error(`Bytes do anexo ${attachment.name} não foram hidratados.`);
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`;
}
