import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalModelManager,
} from '../src/ai/local-model-manager';
import type {
  LocalModelDescriptor,
  LocalModelInstallProgress,
  LocalModelRuntimeAdapter,
  LocalModelRuntimeInfo,
} from '../src/ai/local-model-runtime';

const GIB = 1024 ** 3;

class FakeRuntime implements LocalModelRuntimeAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake Runtime';
  readonly supportsInstallCancellation = true;
  aborted = false;
  removed: string[] = [];

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    return { id: this.id, displayName: this.displayName, available: true };
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    return [{
      id: 'tiny:latest',
      name: 'tiny:latest',
      runtimeId: this.id,
      installed: true,
      sizeBytes: GIB,
    }];
  }

  async *install(modelId: string, signal?: AbortSignal): AsyncGenerator<LocalModelInstallProgress> {
    signal?.addEventListener('abort', () => {
      this.aborted = true;
    }, { once: true });
    yield { runtimeId: this.id, modelId, status: 'pulling', percent: 25, done: false };
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 5);
    });
    yield { runtimeId: this.id, modelId, status: 'success', percent: 100, done: true };
  }

  async remove(modelId: string): Promise<void> {
    this.removed.push(modelId);
  }
}

class ReadOnlyRuntime implements LocalModelRuntimeAdapter {
  readonly id = 'read-only';
  readonly displayName = 'Read Only Runtime';

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    return { id: this.id, displayName: this.displayName, available: true };
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    return [];
  }
}

class NonCancellableRuntime implements LocalModelRuntimeAdapter {
  readonly id = 'managed-no-cancel';
  readonly displayName = 'Managed No Cancel Runtime';
  receivedSignal: AbortSignal | undefined;

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    return { id: this.id, displayName: this.displayName, available: true };
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    return [];
  }

  async *install(modelId: string, signal?: AbortSignal): AsyncGenerator<LocalModelInstallProgress> {
    this.receivedSignal = signal;
    yield { runtimeId: this.id, modelId, status: 'success', percent: 100, done: true };
  }
}

test('local model manager lists runtimes and classifies installed models', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  assert.deepEqual(manager.runtimeIds(), ['fake']);
  const info = await manager.getRuntimeInfo('fake');
  assert.equal(info.available, true);
  assert.deepEqual(info.operations, { install: true, cancelInstall: true, remove: true });

  const models = await manager.listInstalled('fake', {
    totalRamBytes: 16 * GIB,
    availableRamBytes: 12 * GIB,
    freeDiskBytes: 100 * GIB,
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'tiny:latest');
  assert.equal(models[0].compatibility.level, 'excellent');
});

test('installed model compatibility ignores download disk capacity', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  const hardware = {
    totalRamBytes: 8 * GIB,
    availableRamBytes: 6 * GIB,
    freeDiskBytes: 512 * 1024 ** 2,
  };

  const installed = await manager.listInstalled('fake', hardware);
  assert.equal(installed[0].compatibility.level, 'excellent');

  const installable = manager.evaluateModel({ sizeBytes: GIB }, hardware);
  assert.equal(installable.level, 'blocked');
  assert.match(installable.reasons[0], /disco insuficiente/);
});

test('local model manager recommends the strongest agent model that fits safely', () => {
  const manager = new LocalModelManager();
  const recommendation = manager.recommendModel([
    { id: 'qwen3:8b', runtimeId: 'ollama', sizeBytes: 5.2 * GIB, capabilities: ['tools', 'reasoning'] },
    { id: 'qwen3:4b', runtimeId: 'ollama', sizeBytes: 2.5 * GIB, capabilities: ['tools', 'reasoning'] },
    { id: 'gemma3:1b', runtimeId: 'ollama', sizeBytes: 0.8 * GIB, capabilities: [] },
  ], {
    totalRamBytes: 8 * GIB,
    availableRamBytes: 6 * GIB,
    freeDiskBytes: 50 * GIB,
  });
  assert.equal(recommendation?.modelId, 'qwen3:4b');
  assert.equal(recommendation?.compatibility.level, 'excellent');
  assert.match(recommendation?.reason ?? '', /agente/);
});

test('local model manager prefers a safe tool-capable model over an excellent chat-only model', () => {
  const manager = new LocalModelManager();
  const recommendation = manager.recommendModel([
    { id: 'agent:5b', runtimeId: 'ollama', sizeBytes: 5 * GIB, capabilities: ['tools', 'reasoning'] },
    { id: 'chat:1b', runtimeId: 'ollama', sizeBytes: GIB, capabilities: [] },
  ], {
    totalRamBytes: 12 * GIB,
    availableRamBytes: 10 * GIB,
    freeDiskBytes: 50 * GIB,
  });

  assert.equal(recommendation?.modelId, 'agent:5b');
  assert.equal(recommendation?.compatibility.level, 'compatible');
  assert.match(recommendation?.reason ?? '', /agente/);
});

test('local model manager does not prefer a limit-state agent over a safe chat model', () => {
  const manager = new LocalModelManager();
  const recommendation = manager.recommendModel([
    { id: 'agent:3b', runtimeId: 'ollama', sizeBytes: 3 * GIB, capabilities: ['tools', 'reasoning'] },
    { id: 'chat:1b', runtimeId: 'ollama', sizeBytes: GIB, capabilities: [] },
  ], {
    totalRamBytes: 8 * GIB,
    availableRamBytes: 4 * GIB,
    freeDiskBytes: 50 * GIB,
  });

  assert.equal(recommendation?.modelId, 'chat:1b');
  assert.equal(recommendation?.compatibility.level, 'excellent');
  assert.match(recommendation?.reason ?? '', /sem suporte de tools/);
});

test('local model manager describes a non-agent fallback accurately', () => {
  const manager = new LocalModelManager();
  const recommendation = manager.recommendModel([
    { id: 'chat:1b', runtimeId: 'ollama', sizeBytes: GIB, capabilities: ['vision'] },
  ], {
    totalRamBytes: 8 * GIB,
    availableRamBytes: 6 * GIB,
    freeDiskBytes: 50 * GIB,
  });

  assert.equal(recommendation?.modelId, 'chat:1b');
  assert.match(recommendation?.reason ?? '', /sem suporte de tools/);
});

test('local model manager returns no recommendation when every catalog model is blocked', () => {
  const manager = new LocalModelManager();
  const recommendation = manager.recommendModel([
    { id: 'huge:latest', runtimeId: 'ollama', sizeBytes: 10 * GIB, capabilities: ['tools'] },
  ], {
    totalRamBytes: 4 * GIB,
    availableRamBytes: 3 * GIB,
    freeDiskBytes: 4 * GIB,
  });
  assert.equal(recommendation, undefined);
});

test('local model manager rejects duplicate installs and supports cancellation', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  const handle = manager.beginInstall('fake', 'tiny:latest');
  assert.equal(handle.canCancel, true);
  assert.equal(manager.isInstalling('fake', 'tiny:latest'), true);
  assert.throws(() => manager.beginInstall('fake', 'tiny:latest'), /já está sendo instalado/);

  const iterator = handle.progress[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.percent, 25);
  assert.equal(handle.cancel(), true);
  await assert.rejects(() => iterator.next());
  assert.equal(runtime.aborted, true);
  assert.equal(manager.isInstalling('fake', 'tiny:latest'), false);
});

test('local model manager accepts inventory-only runtimes without inventing model operations', async () => {
  const runtime = new ReadOnlyRuntime();
  const manager = new LocalModelManager([runtime]);
  const info = await manager.getRuntimeInfo(runtime.id);

  assert.deepEqual(info.operations, { install: false, cancelInstall: false, remove: false });
  assert.throws(() => manager.beginInstall(runtime.id, 'model'), /não oferece instalação/);
  assert.equal(manager.cancelInstall(runtime.id, 'model'), false);
  await assert.rejects(() => manager.removeInstalled(runtime.id, 'model'), /não oferece remoção/);
});

test('local model manager does not expose cancellation when a runtime cannot cancel installs', async () => {
  const runtime = new NonCancellableRuntime();
  const manager = new LocalModelManager([runtime]);
  const info = await manager.getRuntimeInfo(runtime.id);
  assert.deepEqual(info.operations, { install: true, cancelInstall: false, remove: false });

  const handle = manager.beginInstall(runtime.id, 'model');
  assert.equal(handle.canCancel, false);
  assert.equal(handle.cancel(), false);
  const events = [];
  for await (const event of handle.progress) events.push(event);
  assert.equal(events.at(-1)?.done, true);
  assert.equal(runtime.receivedSignal, undefined);
  assert.equal(manager.isInstalling(runtime.id, 'model'), false);
});

test('local model manager removes only models confirmed as installed', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  await manager.removeInstalled('fake', 'tiny:latest');
  assert.deepEqual(runtime.removed, ['tiny:latest']);
  await assert.rejects(() => manager.removeInstalled('fake', 'missing:latest'), /não está instalado/);
  assert.deepEqual(runtime.removed, ['tiny:latest']);
});

test('local model manager refuses removal while the same model is installing', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  const handle = manager.beginInstall('fake', 'tiny:latest');
  await assert.rejects(() => manager.removeInstalled('fake', 'tiny:latest'), /Cancele a instalação/);
  handle.cancel();
  const iterator = handle.progress[Symbol.asyncIterator]();
  await assert.rejects(async () => {
    while (!(await iterator.next()).done) {
      // Drain until cancellation is observed.
    }
  });
});

test('local model manager rejects unknown runtimes', async () => {
  const manager = new LocalModelManager();
  await assert.rejects(() => manager.getRuntimeInfo('missing'), /não registrado/);
  assert.throws(() => manager.beginInstall('missing', 'model'), /não registrado/);
  await assert.rejects(() => manager.removeInstalled('missing', 'model'), /não registrado/);
});
