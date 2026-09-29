import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InstanceRuntime,
  type InstancePlatformAdapter,
  type InstancePlatformHandle,
} from '../src/agent/instance-runtime';

type FakeHandle = InstancePlatformHandle & {
  opened: boolean;
  focusCalls: number;
  closeCalls: number;
  emitClosed: () => void;
};

function fixture(options: { failOpen?: boolean; controllable?: boolean } = {}) {
  let id = 0;
  let now = 1000;
  const handles = new Map<string, FakeHandle>();

  const platform: InstancePlatformAdapter = {
    async open(input) {
      if (options.failOpen) throw new Error('platform open failed');

      let closedListener: (() => void) | undefined;
      const handle: FakeHandle = {
        opened: true,
        focusCalls: 0,
        closeCalls: 0,
        canFocus: options.controllable !== false,
        canClose: options.controllable !== false,
        focus: options.controllable === false ? undefined : async () => {
          handle.focusCalls += 1;
        },
        close: options.controllable === false ? undefined : async () => {
          handle.closeCalls += 1;
          handle.opened = false;
        },
        isOpen: () => handle.opened,
        onClosed(listener) {
          closedListener = listener;
          return () => {
            if (closedListener === listener) closedListener = undefined;
          };
        },
        emitClosed() {
          handle.opened = false;
          closedListener?.();
        },
      };
      handles.set(input.instanceId, handle);
      return handle;
    },
  };

  return {
    runtime: new InstanceRuntime(platform, () => `instance-${++id}`, () => ++now),
    handles,
  };
}

test('InstanceRuntime opens and registers a controllable preview lifecycle', async () => {
  const f = fixture();
  const opened = await f.runtime.open({
    projectId: 'project-a',
    kind: 'preview',
    target: 'http://localhost:5173',
  });

  assert.equal(opened.instanceId, 'instance-1');
  assert.equal(opened.projectId, 'project-a');
  assert.equal(opened.kind, 'preview');
  assert.equal(opened.target, 'http://localhost:5173/');
  assert.equal(opened.status, 'open');
  assert.deepEqual(opened.capabilities, { focus: true, close: true });
  assert.equal(f.runtime.get(opened.instanceId).status, 'open');
  assert.deepEqual(f.runtime.list('project-a').map((item) => item.instanceId), ['instance-1']);
});

test('InstanceRuntime focus delegates only when the platform handle supports it', async () => {
  const f = fixture();
  const opened = await f.runtime.open({ projectId: 'project-a', kind: 'preview', target: 'https://example.com' });

  const focused = await f.runtime.focus(opened.instanceId);
  assert.equal(focused.status, 'open');
  assert.equal(f.handles.get(opened.instanceId)?.focusCalls, 1);

  const external = fixture({ controllable: false });
  const externalOpened = await external.runtime.open({ projectId: 'project-a', kind: 'url', target: 'https://example.com' });
  await assert.rejects(() => external.runtime.focus(externalOpened.instanceId), /não oferece controle de foco/i);
  assert.equal(external.runtime.get(externalOpened.instanceId).status, 'open');
});

test('InstanceRuntime close is lifecycle-aware and idempotent after closure', async () => {
  const f = fixture();
  const opened = await f.runtime.open({ projectId: 'project-a', kind: 'preview', target: 'http://127.0.0.1:3000' });

  const closed = await f.runtime.close(opened.instanceId);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closedAt);
  assert.equal(f.handles.get(opened.instanceId)?.closeCalls, 1);

  const closedAgain = await f.runtime.close(opened.instanceId);
  assert.equal(closedAgain.status, 'closed');
  assert.equal(f.handles.get(opened.instanceId)?.closeCalls, 1);
});

test('InstanceRuntime observes platform-driven closure without a close command', async () => {
  const f = fixture();
  const opened = await f.runtime.open({ projectId: 'project-a', kind: 'preview', target: 'http://localhost:8080' });

  f.handles.get(opened.instanceId)?.emitClosed();
  const snapshot = f.runtime.get(opened.instanceId);
  assert.equal(snapshot.status, 'closed');
  assert.ok(snapshot.closedAt);
});

test('InstanceRuntime does not claim focus/close support for external uncontrolled handles', async () => {
  const f = fixture({ controllable: false });
  const opened = await f.runtime.open({ projectId: 'project-a', kind: 'url', target: 'https://example.com/path' });

  assert.deepEqual(opened.capabilities, { focus: false, close: false });
  await assert.rejects(() => f.runtime.close(opened.instanceId), /não oferece controle de fechamento/i);
  assert.equal(f.runtime.get(opened.instanceId).status, 'open');
});

test('InstanceRuntime retains failed open attempts as failed lifecycle records', async () => {
  const f = fixture({ failOpen: true });

  await assert.rejects(
    () => f.runtime.open({ projectId: 'project-a', kind: 'application', target: 'missing-app.exe' }),
    /platform open failed/,
  );

  const [failed] = f.runtime.list('project-a');
  assert.ok(failed);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /platform open failed/);
  assert.equal(f.runtime.remove(failed.instanceId), true);
});

test('InstanceRuntime validates URL protocols and required identity before platform effects', async () => {
  const f = fixture();

  await assert.rejects(
    () => f.runtime.open({ projectId: 'project-a', kind: 'url', target: 'javascript:alert(1)' }),
    /apenas http:\/\/ ou https:\/\//i,
  );
  await assert.rejects(
    () => f.runtime.open({ projectId: '', kind: 'file', target: 'a.txt' }),
    /projectId.*obrigatório/i,
  );
  await assert.rejects(
    () => f.runtime.open({ projectId: 'project-a', kind: 'folder', target: '   ' }),
    /não pode estar vazio/i,
  );
  assert.equal(f.runtime.list().length, 0);
});

test('InstanceRuntime filters projects and snapshots are defensively cloned', async () => {
  const f = fixture();
  const a = await f.runtime.open({ projectId: 'project-a', kind: 'file', target: 'a.txt' });
  await f.runtime.open({ projectId: 'project-b', kind: 'folder', target: 'src' });

  const snapshot = f.runtime.get(a.instanceId);
  snapshot.capabilities.close = false;
  snapshot.target = 'mutated';

  assert.equal(f.runtime.get(a.instanceId).target, 'a.txt');
  assert.equal(f.runtime.get(a.instanceId).capabilities.close, true);
  assert.equal(f.runtime.list('project-a').length, 1);
  assert.equal(f.runtime.list('project-b').length, 1);
});

test('InstanceRuntime refuses duplicate ids and active record removal', async () => {
  const platform: InstancePlatformAdapter = {
    async open() {
      return {
        canFocus: false,
        canClose: false,
        isOpen: () => true,
      };
    },
  };
  const runtime = new InstanceRuntime(platform, () => 'same-id');
  const opened = await runtime.open({ projectId: 'project-a', kind: 'file', target: 'a.txt' });

  assert.throws(() => runtime.remove(opened.instanceId), /ainda ativa/i);
  await assert.rejects(
    () => runtime.open({ projectId: 'project-a', kind: 'file', target: 'b.txt' }),
    /duplicado/i,
  );
});
