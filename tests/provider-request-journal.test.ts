import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRequestJournal } from '../src/ai/provider-request-journal';
import type { AIRequest, AIResponse } from '../src/ai/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

const request: AIRequest = {
  providerId: 'test-provider',
  model: 'test-model',
  messages: [{ role: 'user', content: 'Do the task.' }],
  intelligence: 'normal',
  projectContext: 'src/index.ts',
  toolsEnabled: true,
  tools: [{ name: 'read_file', description: 'Read a file.', parameters: {}, requiresWriteAccess: false, requiresApproval: false }],
};

const response: AIResponse = {
  providerId: 'test-provider',
  model: 'test-model',
  content: 'Done.',
};

test('persists a pending provider request before the provider call', async () => {
  const storage = new MemoryStorage();
  const journal = new ProviderRequestJournal(storage);
  await journal.init();

  const created = await journal.begin(request);
  assert.ok(created.requestId);
  assert.equal(created.cachedResponse, undefined);

  const persisted = await storage.read<{ version: number; entries: Array<{ requestId: string; status: string }> }>('provider-requests.json', { version: 0, entries: [] });
  assert.equal(persisted.version, 1);
  assert.deepEqual(persisted.entries.map((entry) => ({ requestId: entry.requestId, status: entry.status })), [{ requestId: created.requestId, status: 'pending' }]);
});

test('recovers a completed response without sending the provider request again', async () => {
  const storage = new MemoryStorage();
  const first = new ProviderRequestJournal(storage);
  await first.init();
  const created = await first.begin(request);
  await first.complete(created.requestId, response);

  const recovered = new ProviderRequestJournal(storage);
  await recovered.init();
  const result = await recovered.begin({ ...request, tools: [...request.tools!] });

  assert.equal(result.requestId, created.requestId);
  assert.deepEqual(result.cachedResponse, response);
  assert.equal(recovered.list().length, 1);
});

test('blocks automatic retry when a matching request was interrupted', async () => {
  const storage = new MemoryStorage();
  const first = new ProviderRequestJournal(storage);
  await first.init();
  await first.begin(request);

  const recovered = new ProviderRequestJournal(storage);
  await recovered.init();

  await assert.rejects(recovered.begin(request), /solicitação ao provider interrompida/);
  assert.equal(recovered.listInterrupted().length, 1);
});

test('allows an explicit new request after a failed request', async () => {
  const storage = new MemoryStorage();
  const journal = new ProviderRequestJournal(storage);
  await journal.init();
  const failed = await journal.begin(request);
  await journal.fail(failed.requestId, 'timeout');

  const retry = await journal.begin(request);

  assert.notEqual(retry.requestId, failed.requestId);
  assert.equal(retry.cachedResponse, undefined);
  assert.equal(journal.list().length, 2);
});

test('discard removes an interrupted request', async () => {
  const storage = new MemoryStorage();
  const journal = new ProviderRequestJournal(storage);
  await journal.init();
  const created = await journal.begin(request);

  await journal.discard(created.requestId);

  assert.deepEqual(journal.list(), []);
  assert.deepEqual(journal.listInterrupted(), []);
});
