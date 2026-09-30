import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AttachmentStore } from '../src/ai/attachment-store';
import { imageDataUrl, nativeImageAttachments } from '../src/ai/provider-attachments';
import { InstanceCaptureArtifactRuntime } from '../src/agent/instance-capture-artifact-runtime';
import { InstanceRuntime, type InstancePlatformHandle } from '../src/agent/instance-runtime';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/gAAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(image: () => Promise<Buffer> = async () => PNG) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-instance-capture-artifacts-'));
  let open = true;
  let captureCalls = 0;
  const instances = new InstanceRuntime({
    async open({ kind }): Promise<InstancePlatformHandle> {
      if (kind !== 'preview') return { canFocus: false, canClose: false };
      return {
        canFocus: true,
        canClose: true,
        focus: () => undefined,
        close: () => { open = false; },
        isOpen: () => open,
        capture: async () => { captureCalls += 1; return image(); },
      };
    },
  });
  const store = new AttachmentStore(() => root);
  return {
    root,
    instances,
    store,
    artifacts: new InstanceCaptureArtifactRuntime(instances, store),
    captureCalls: () => captureCalls,
    close: () => { open = false; },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('preview capture reuses the verified attachment store without exposing base64 in metadata', async () => {
  const f = await fixture();
  try {
    const instance = await f.instances.open({ projectId: 'project-a', kind: 'preview', target: 'http://localhost:5173' });
    const result = await f.artifacts.capture('project-a', instance.instanceId);
    assert.equal(result.instanceId, instance.instanceId);
    assert.equal(result.projectId, 'project-a');
    assert.equal(result.attachment.kind, 'image');
    assert.equal(result.attachment.mediaType, 'image/png');
    assert.equal(result.attachment.size, PNG.length);
    assert.equal(result.attachment.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
    assert.equal(result.attachment.storageKey, result.attachment.sha256);
    assert.equal(result.attachment.dataBase64, undefined);
    assert.deepEqual(await f.store.readBytes(result.attachment), PNG);
    const hydrated = await f.store.hydrate(result.attachment);
    assert.deepEqual(nativeImageAttachments({ role: 'tool', content: '', attachments: [hydrated] }), [hydrated]);
    assert.equal(imageDataUrl(hydrated), `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(f.captureCalls(), 1);
  } finally {
    await f.cleanup();
  }
});

test('foreign project is rejected before capture and persistence', async () => {
  const f = await fixture();
  try {
    const instance = await f.instances.open({ projectId: 'project-a', kind: 'preview', target: 'http://localhost:5173' });
    await assert.rejects(() => f.artifacts.capture('project-b', instance.instanceId), /outro projeto/i);
    assert.equal(f.captureCalls(), 0);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});

test('external URL and closed previews cannot be captured', async () => {
  const f = await fixture();
  try {
    const url = await f.instances.open({ projectId: 'project-a', kind: 'url', target: 'https://example.com' });
    await assert.rejects(() => f.artifacts.capture('project-a', url.instanceId), /Somente previews/i);
    const preview = await f.instances.open({ projectId: 'project-a', kind: 'preview', target: 'http://localhost:3000' });
    f.close();
    await assert.rejects(() => f.artifacts.capture('project-a', preview.instanceId), /não está aberta/i);
    assert.equal(f.captureCalls(), 0);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});

test('invalid PNG bytes are rejected without persisting an attachment', async () => {
  const f = await fixture(async () => Buffer.from('not-a-png'));
  try {
    const preview = await f.instances.open({ projectId: 'project-a', kind: 'preview', target: 'http://localhost:3000' });
    await assert.rejects(() => f.artifacts.capture('project-a', preview.instanceId), /imagem PNG válida/i);
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally {
    await f.cleanup();
  }
});
