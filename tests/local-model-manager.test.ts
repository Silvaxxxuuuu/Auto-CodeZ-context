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

class FakeRuntime implements LocalModelRuntimeAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake Runtime';
  aborted = false;

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    return { id: this.id, displayName: this.displayName, available: true };
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    return [{
      id: 'tiny:latest',
      name: 'tiny:latest',
      runtimeId: this.id,
      installed: true,
      sizeBytes: 1024 ** 3,
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
}

test('local model manager lists runtimes and classifies installed models', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  assert.deepEqual(manager.runtimeIds(), ['fake']);
  assert.equal((await manager.getRuntimeInfo('fake')).available, true);

  const models = await manager.listInstalled('fake', {
    totalRamBytes: 16 * 1024 ** 3,
    availableRamBytes: 12 * 1024 ** 3,
    freeDiskBytes: 100 * 1024 ** 3,
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'tiny:latest');
  assert.equal(models[0].compatibility.level, 'excellent');
});

test('local model manager rejects duplicate installs and supports cancellation', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  const handle = manager.beginInstall('fake', 'tiny:latest');
  assert.equal(manager.isInstalling('fake', 'tiny:latest'), true);
  assert.throws(() => manager.beginInstall('fake', 'tiny:latest'), /já está sendo instalado/);

  const iterator = handle.progress[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.percent, 25);
  assert.equal(manager.cancelInstall('fake', 'tiny:latest'), true);
  await assert.rejects(() => iterator.next());
  assert.equal(runtime.aborted, true);
  assert.equal(manager.isInstalling('fake', 'tiny:latest'), false);
});

test('local model manager rejects unknown runtimes', async () => {
  const manager = new LocalModelManager();
  await assert.rejects(() => manager.getRuntimeInfo('missing'), /não registrado/);
  assert.throws(() => manager.beginInstall('missing', 'model'), /não registrado/);
});
