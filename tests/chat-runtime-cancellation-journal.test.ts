import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import { ProviderRequestJournal } from '../src/ai/provider-request-journal';
import type { AIModel, AIProviderAdapter, AIProviderConfig, AIStreamEvent, ChatRecord } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'mock',
  displayName: 'Mock',
  apiKey: 'test-key',
  enabled: true,
  selectedModel: 'mock-model',
};

const chat: ChatRecord = {
  id: 'chat-1',
  title: 'Teste',
  providerId: 'mock',
  model: 'mock-model',
  intelligence: 'normal',
  permissionLevel: 'safe',
  messages: [{ role: 'user', content: 'Olá' }],
  createdAt: 1,
  updatedAt: 2,
};

const model: AIModel = {
  id: 'mock-model',
  name: 'Mock Model',
  providerId: 'mock',
  capabilities: ['text', 'streaming'],
};

function abortError(): Error {
  const error = new Error('Operação cancelada.');
  error.name = 'AbortError';
  return error;
}

test('stopping an active provider stream marks its journal entry failed instead of interrupted', async () => {
  const adapter: AIProviderAdapter = {
    id: 'mock',
    displayName: 'Mock',
    async listModels(): Promise<AIModel[]> {
      return [model];
    },
    async send() {
      return { content: '', model: 'mock-model', providerId: 'mock' };
    },
    async *stream(_providerConfig, _request, signal): AsyncGenerator<AIStreamEvent> {
      yield { type: 'start' };
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => reject(abortError());
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };

  const registry = new ProviderRegistry();
  registry.register(adapter);
  const journal = new ProviderRequestJournal();
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [], journal);
  const controller = new AbortController();

  const consume = async (): Promise<void> => {
    for await (const _event of runtime.stream(config, chat, undefined, controller.signal)) {
      controller.abort();
    }
  };

  await assert.rejects(consume(), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(journal.listInterrupted().length, 0);
  assert.equal(journal.list().length, 1);
  assert.equal(journal.list()[0]?.status, 'failed');
  assert.match(journal.list()[0]?.error ?? '', /cancelada pelo usuário/i);
});
