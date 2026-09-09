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

test('local model manager lists runtimes and classifies installed models', async () => {
  const runtime = new FakeRuntime();
  const manager = new LocalModelManager([runtime]);
  assert.deepEqual(manager.runtimeIds(), ['fake']);
  assert.equal((await manager.getRuntimeInfo('fake')).available, true);

  const models = await manager.listInstalled('fake', {
    totalRamBytes: 16 * GIB,
    availableRamBytes: 12 * GIB,
    freeDiskBytes: 100 * GIB,
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'tiny:latest');
  assert.equal(models[0].compatibility.level, 'excellent');
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
