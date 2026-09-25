import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from '../src/ai/attachment-store';

test('AttachmentStore imports text content-addressed, hydrates bytes, and caches derived contexts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-attachments-'));
  const source = path.join(root, 'sample.ts');
  await fs.writeFile(source, 'export const answer = 42;\n', 'utf8');
  const store = new AttachmentStore(() => path.join(root, 'store'));

  const attachment = await store.importFile(source);
  assert.equal(attachment.kind, 'text');
  assert.equal(attachment.name, 'sample.ts');
  assert.match(attachment.sha256, /^[a-f0-9]{64}$/);
  assert.equal(attachment.storageKey, attachment.sha256);
  assert.match(attachment.contexts?.[0]?.text ?? '', /answer = 42/);

  const hydrated = await store.hydrate(attachment);
  assert.equal(Buffer.from(hydrated.dataBase64 ?? '', 'base64').toString('utf8'), 'export const answer = 42;\n');

  const indexed = await store.saveContext(hydrated, {
    kind: 'caption',
    text: 'Arquivo TypeScript contendo a constante answer igual a 42.',
    model: 'vision-test',
    createdAt: 123,
  });
  assert.equal(indexed.contexts?.some((item) => item.model === 'vision-test'), true);

  const restored = await store.hydrate({ ...attachment, contexts: undefined });
  assert.equal(restored.contexts?.some((item) => item.model === 'vision-test'), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('AttachmentStore rejects tampered attachment references before bytes reach providers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-attachments-'));
  const source = path.join(root, 'sample.txt');
  await fs.writeFile(source, 'safe', 'utf8');
  const store = new AttachmentStore(() => path.join(root, 'store'));
  const attachment = await store.importFile(source);

  await assert.rejects(
    store.validateReference({ ...attachment, sha256: 'b'.repeat(64) }),
    /Referência do anexo inválida|integridade/i,
  );

  await fs.writeFile(path.join(root, 'store', attachment.sha256.slice(0, 2), attachment.sha256), 'tampered');
  await assert.rejects(store.hydrate(attachment), /Integridade|Tamanho/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('AttachmentStore extracts text from a simple textual PDF stream without external services', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-attachments-'));
  const source = path.join(root, 'sample.pdf');
  const pdf = '%PDF-1.4\n1 0 obj\n<< /Length 45 >>\nstream\nBT /F1 12 Tf 72 720 Td (Auto CodeZ PDF text) Tj ET\nendstream\nendobj\n%%EOF';
  await fs.writeFile(source, Buffer.from(pdf, 'latin1'));
  const store = new AttachmentStore(() => path.join(root, 'store'));

  const attachment = await store.importFile(source);
  assert.equal(attachment.kind, 'document');
  assert.match(attachment.contexts?.[0]?.text ?? '', /Auto CodeZ PDF text/);
  await fs.rm(root, { recursive: true, force: true });
});
