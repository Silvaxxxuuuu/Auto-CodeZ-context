import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentFallbackContext, resolveAttachmentDelivery } from '../src/ai/attachment-context';
import type { AIAttachment } from '../src/ai/types';

function image(contexts: AIAttachment['contexts'] = []): AIAttachment {
  return {
    id: 'att-1',
    kind: 'image',
    name: 'screenshot.png',
    mediaType: 'image/png',
    size: 1234,
    storageKey: 'sha256/abc',
    sha256: 'abc',
    createdAt: 100,
    width: 1280,
    height: 720,
    contexts,
  };
}

test('vision-capable models receive original images natively', () => {
  const attachment = image([{ kind: 'caption', text: 'Uma janela do Auto CodeZ.', createdAt: 100 }]);
  const delivery = resolveAttachmentDelivery(attachment, ['text', 'vision']);

  assert.equal(delivery.mode, 'native');
  assert.equal(delivery.attachment.id, 'att-1');
});

test('text-only models receive derived image context instead of pretending to see pixels', () => {
  const attachment = image([
    { kind: 'metadata', text: '1280x720', createdAt: 100 },
    { kind: 'ocr', text: 'Erro: provider unavailable', createdAt: 100 },
    { kind: 'caption', text: 'Tela de erro do aplicativo.', createdAt: 100 },
  ]);
  const delivery = resolveAttachmentDelivery(attachment, ['text']);

  assert.equal(delivery.mode, 'text');
  assert.match(delivery.text, /Erro: provider unavailable/);
  assert.doesNotMatch(delivery.text, /Tela de erro do aplicativo/);
});

test('unindexed attachments are explicit instead of silently disappearing', () => {
  const context = attachmentFallbackContext([image()], ['text']);

  assert.match(context, /screenshot\.png/);
  assert.match(context, /ainda não foi indexado/);
});

test('native vision attachments are excluded from textual fallback context', () => {
  const context = attachmentFallbackContext([
    image([{ kind: 'ocr', text: 'Texto visível', createdAt: 100 }]),
  ], ['text', 'vision']);

  assert.equal(context, '');
});
