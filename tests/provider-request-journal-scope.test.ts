import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintProviderScope, ProviderRequestJournal } from '../src/ai/provider-request-journal';
import type { AIProviderConfig, AIRequest, AIResponse } from '../src/ai/types';

const request: AIRequest = {
  providerId: 'openai',
  model: 'test-model',
  messages: [{ role: 'user', content: 'Do the task.' }],
  intelligence: 'normal',
  toolsEnabled: false,
};

const response: AIResponse = {
  providerId: 'openai',
  model: 'test-model',
  content: 'Done.',
};

function config(apiKey: string): AIProviderConfig {
  return { id: 'openai', displayName: 'OpenAI', apiKey, enabled: true };
}

test('provider request scope differs between API keys without exposing the raw key', () => {
  const first = fingerprintProviderScope(config('secret-key-a'));
  const second = fingerprintProviderScope(config('secret-key-b'));

  assert.notEqual(first, second);
  assert.equal(first.includes('secret-key-a'), false);
  assert.equal(second.includes('secret-key-b'), false);
});

test('pending request from one credential does not block the same request on another credential', async () => {
  const journal = new ProviderRequestJournal();
  const first = await journal.begin(request, fingerprintProviderScope(config('key-a')));
  const second = await journal.begin(request, fingerprintProviderScope(config('key-b')));

  assert.notEqual(first.requestId, second.requestId);
  assert.equal(journal.listInterrupted().length, 2);
});

test('completed response from one credential is not reused by another credential', async () => {
  const journal = new ProviderRequestJournal();
  const first = await journal.begin(request, fingerprintProviderScope(config('key-a')));
  await journal.complete(first.requestId, response);

  const second = await journal.begin(request, fingerprintProviderScope(config('key-b')));

  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.cachedResponse, undefined);
});

test('journal bounds settled history while preserving pending requests', async () => {
  const journal = new ProviderRequestJournal();
  const pending = await journal.begin({ ...request, messages: [{ role: 'user', content: 'pending' }] }, 'scope-pending');

  for (let index = 0; index < 205; index += 1) {
    const item = await journal.begin({ ...request, messages: [{ role: 'user', content: `request-${index}` }] }, 'scope');
    await journal.complete(item.requestId, { ...response, content: `response-${index}` });
  }

  assert.equal(journal.listInterrupted().some((entry) => entry.requestId === pending.requestId), true);
  assert.equal(journal.list().filter((entry) => entry.status !== 'pending').length, 200);
  assert.equal(journal.list().length, 201);
});
