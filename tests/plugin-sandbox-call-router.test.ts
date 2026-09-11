import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginSandboxCallRouter } from '../src/plugins/plugin-sandbox-call-router';

type DestroyListener = () => void;

function fakeTarget(id = 41) {
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let destroyed = false;
  let onDestroyed: DestroyListener | undefined;
  return {
    target: {
      id,
      isDestroyed: (): boolean => destroyed,
      once: (event: string, listener: DestroyListener): undefined => {
        if (event === 'destroyed') onDestroyed = listener;
        return undefined;
      },
      send: (channel: string, payload: Record<string, unknown>): void => { sent.push({ channel, payload }); },
    },
    sent,
    destroy: (): void => {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

test('sandbox router cancels only pending calls owned by the disabled plugin', async () => {
  const router = new PluginSandboxCallRouter();
  const fake = fakeTarget();
  router.bind(fake.target as never);

  const first = router.call('plugin.a', 'write_scene', { value: 1 });
  const second = router.call('plugin.b', 'read_scene', { value: 2 });
  assert.equal(fake.sent.length, 2);
  assert.equal(router.cancelPlugin('plugin.a', 'plugin a disabled'), 1);
  await assert.rejects(first, /plugin a disabled/i);

  const secondPayload = fake.sent[1].payload;
  const resolved = router.resolve({ sender: { id: 41 } } as never, { id: secondPayload.id, value: { ok: true } });
  assert.equal(resolved, true);
  assert.deepEqual(await second, { ok: true });
});

test('sandbox router rejects all pending calls when its renderer is destroyed', async () => {
  const router = new PluginSandboxCallRouter();
  const fake = fakeTarget(77);
  router.bind(fake.target as never);

  const pending = router.call('plugin.a', 'long_task', { value: true });
  fake.destroy();
  await assert.rejects(pending, /renderer da plugin platform foi encerrado/i);
});
