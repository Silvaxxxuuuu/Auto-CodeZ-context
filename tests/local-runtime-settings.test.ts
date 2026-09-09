import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LocalRuntimeSettingsStore,
  type LocalRuntimeSettingsStorage,
} from '../src/ai/local-runtime-settings';

type FailureMode = 'none' | 'metadata' | 'secret';

class MemoryStorage implements LocalRuntimeSettingsStorage {
  readonly values = new Map<string, unknown>();
  readonly encrypted = new Map<string, string>();
  failure: FailureMode = 'none';

  async read<T>(name: string, fallback: T): Promise<T> {
    return (this.values.has(name) ? this.values.get(name) : fallback) as T;
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (this.failure === 'metadata') throw new Error('metadata write failed');
    this.values.set(name, structuredClone(value));
  }

  async readEncrypted(name: string): Promise<string | null> {
    return this.encrypted.get(name) ?? null;
  }

  async writeEncrypted(name: string, value: string): Promise<void> {
    if (this.failure === 'secret') throw new Error('secret write failed');
    this.encrypted.set(name, value);
  }
}

async function withoutEnvironmentToken(action: () => Promise<void>): Promise<void> {
  const previous = process.env.LM_API_TOKEN;
  delete process.env.LM_API_TOKEN;
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.LM_API_TOKEN;
    else process.env.LM_API_TOKEN = previous;
  }
}

test('runtime settings start with loopback defaults and never expose a token value', async () => {
  await withoutEnvironmentToken(async () => {
    const store = new LocalRuntimeSettingsStore(new MemoryStorage());
    await store.init();
    assert.deepEqual(store.list(), [
      {
        runtimeId: 'ollama',
        displayName: 'Ollama',
        endpoint: 'http://127.0.0.1:11434',
        tokenSupported: false,
        tokenConfigured: false,
      },
      {
        runtimeId: 'lm-studio',
        displayName: 'LM Studio',
        endpoint: 'http://127.0.0.1:1234',
        tokenSupported: true,
        tokenConfigured: false,
      },
    ]);
    assert.equal('apiToken' in store.list()[1]!, false);
  });
});

test('LM Studio endpoint and token persist separately and restore without exposing the secret', async () => {
  await withoutEnvironmentToken(async () => {
    const storage = new MemoryStorage();
    const store = new LocalRuntimeSettingsStore(storage);
    await store.init();
    const saved = await store.save({
      runtimeId: 'lm-studio',
      endpoint: 'http://localhost:1234/v1/',
      apiToken: '  secret-local-token  ',
    });

    assert.equal(saved.endpoint, 'http://localhost:1234');
    assert.equal(saved.tokenConfigured, true);
    assert.equal('apiToken' in saved, false);
    assert.equal(JSON.stringify(storage.values.get('local-runtime-settings.json')).includes('secret-local-token'), false);
    const secretPayload = storage.encrypted.get('local-runtime-secrets.json');
    assert.ok(secretPayload?.includes('secret-local-token'));

    const restored = new LocalRuntimeSettingsStore(storage);
    await restored.init();
    assert.deepEqual(restored.get('lm-studio'), {
      endpoint: 'http://localhost:1234',
      apiToken: 'secret-local-token',
    });
    const summary = restored.list().find((item) => item.runtimeId === 'lm-studio');
    assert.equal(summary?.tokenConfigured, true);
    assert.equal(summary && 'apiToken' in summary, false);
  });
});

test('clearing the LM Studio token preserves the endpoint and removes it from encrypted state', async () => {
  await withoutEnvironmentToken(async () => {
    const storage = new MemoryStorage();
    const store = new LocalRuntimeSettingsStore(storage);
    await store.init();
    await store.save({ runtimeId: 'lm-studio', endpoint: 'http://127.0.0.1:1234', apiToken: 'secret' });
    const cleared = await store.save({ runtimeId: 'lm-studio', endpoint: 'http://127.0.0.1:1234', clearToken: true });
    assert.equal(cleared.tokenConfigured, false);
    assert.deepEqual(store.get('lm-studio'), { endpoint: 'http://127.0.0.1:1234' });
    assert.equal(storage.encrypted.get('local-runtime-secrets.json')?.includes('secret'), false);
  });
});

test('runtime settings reject remote endpoints and unsupported Ollama tokens', async () => {
  await withoutEnvironmentToken(async () => {
    const store = new LocalRuntimeSettingsStore(new MemoryStorage());
    await store.init();
    await assert.rejects(
      () => store.save({ runtimeId: 'lm-studio', endpoint: 'http://192.168.1.20:1234' }),
      /loopback/,
    );
    await assert.rejects(
      () => store.save({ runtimeId: 'ollama', endpoint: 'http://127.0.0.1:11434', apiToken: 'not-supported' }),
      /não usa token/,
    );
  });
});

test('failed persistence does not publish or retain partially saved settings in memory', async () => {
  await withoutEnvironmentToken(async () => {
    const storage = new MemoryStorage();
    const store = new LocalRuntimeSettingsStore(storage);
    await store.init();
    const before = store.get('lm-studio');
    storage.failure = 'secret';
    await assert.rejects(
      () => store.save({ runtimeId: 'lm-studio', endpoint: 'http://localhost:1234', apiToken: 'new-secret' }),
      /secret write failed/,
    );
    assert.deepEqual(store.get('lm-studio'), before);
    assert.equal(store.list().find((item) => item.runtimeId === 'lm-studio')?.tokenConfigured, false);
  });
});
