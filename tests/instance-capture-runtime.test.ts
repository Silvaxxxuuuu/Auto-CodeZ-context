import assert from 'node:assert/strict';
import test from 'node:test';
import { InstanceRuntime, type InstancePlatformHandle } from '../src/agent/instance-runtime';

function fixture(capture: () => Promise<Buffer> = async () => Buffer.from('valid-image')) {
  let open = true;
  const runtime = new InstanceRuntime({
    async open({ kind }): Promise<InstancePlatformHandle> {
      if (kind !== 'preview') return { canFocus: false, canClose: false };
      return {
        canFocus: true,
        canClose: true,
        close: () => { open = false; },
        focus: () => undefined,
        isOpen: () => open,
        capture,
      };
    },
  });
  return { runtime, closeFromPlatform: () => { open = false; } };
}

test('managed preview captures bytes without changing the existing focus/close contract', async () => {
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const f = fixture(async () => image);
  const opened = await f.runtime.open({ projectId: 'a', kind: 'preview', target: 'http://localhost:3000' });
  assert.deepEqual(opened.capabilities, { focus: true, close: true });
  const captured = await f.runtime.capture(opened.instanceId);
  assert.deepEqual(captured, image);
  assert.equal(f.runtime.get(opened.instanceId).status, 'open');
  assert.equal(f.runtime.get(opened.instanceId).error, undefined);
});

test('uncontrolled external instances cannot capture', async () => {
  const f = fixture();
  const opened = await f.runtime.open({ projectId: 'a', kind: 'url', target: 'https://example.com' });
  await assert.rejects(() => f.runtime.capture(opened.instanceId), /não oferece captura controlada/i);
});

test('closed previews refuse capture before invoking the platform', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return Buffer.from('image'); });
  const opened = await f.runtime.open({ projectId: 'a', kind: 'preview', target: 'http://localhost:3000' });
  f.closeFromPlatform();
  await assert.rejects(() => f.runtime.capture(opened.instanceId), /não está aberta/i);
  assert.equal(calls, 0);
});

test('capture refuses empty images and oversized buffers', async () => {
  for (const bytes of [0, 8 * 1024 * 1024 + 1]) {
    const f = fixture(async () => Buffer.alloc(bytes));
    const opened = await f.runtime.open({ projectId: 'a', kind: 'preview', target: 'http://localhost:3000' });
    await assert.rejects(() => f.runtime.capture(opened.instanceId), /Captura inválida|limite/i);
    assert.equal(f.runtime.get(opened.instanceId).status, 'open');
  }
});

test('capture fails when preview closes during asynchronous capture', async () => {
  const deferred: { resolve?: (image: Buffer) => void } = {};
  const f = fixture(() => new Promise<Buffer>((resolve) => { deferred.resolve = resolve; }));
  const opened = await f.runtime.open({ projectId: 'a', kind: 'preview', target: 'http://localhost:3000' });
  const pending = f.runtime.capture(opened.instanceId);
  f.closeFromPlatform();
  assert.ok(deferred.resolve);
  deferred.resolve(Buffer.from('image'));
  await assert.rejects(pending, /fechada durante a captura/i);
  assert.equal(f.runtime.get(opened.instanceId).status, 'closed');
});
