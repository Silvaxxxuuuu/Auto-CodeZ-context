import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIModel, AIProviderAdapter, AIProviderConfig, ChatRecord } from '../src/ai/types';

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

function createRuntime(events: Parameters<NonNullable<AIProviderAdapter['stream']>>[1] extends never ? never : 'unused', stream: NonNullable<AIProviderAdapter['stream']>): ChatRuntime {
  void events;
  const adapter: AIProviderAdapter = {
    id: 'mock',
    displayName: 'Mock',
    async listModels(): Promise<AIModel[]> {
      return [model];
    },
    async send() {
      return { content: 'resposta', model: 'mock-model', providerId: 'mock' };
    },
    stream,
  };
  const registry = new ProviderRegistry();
  registry.register(adapter);
  return new ChatRuntime(registry);
}

test('streams start, deltas and completion in provider order', async () => {
  const runtime = createRuntime('unused', async function* () {
    yield { type: 'start' };
    yield { type: 'delta', text: 'res' };
    yield { type: 'delta', text: 'posta' };
    yield { type: 'complete', response: { content: 'resposta', model: 'mock-model', providerId: 'mock' } };
  });

  const received: string[] = [];
  for await (const event of runtime.stream(config, chat)) {
    received.push(event.type);
  }

  assert.deepEqual(received, ['start', 'delta', 'delta', 'complete']);
});

test('converts provider stream failures into a terminal error event', async () => {
  const runtime = createRuntime('unused', async function* () {
    yield { type: 'start' };
    yield { type: 'delta', text: 'parcial' };
    throw new Error('provider indisponível');
  });

  const received: string[] = [];
  let terminalError: string | undefined;
  for await (const event of runtime.stream(config, chat)) {
    received.push(event.type);
    if (event.type === 'error') terminalError = event.error;
  }

  assert.deepEqual(received, ['start', 'delta', 'error']);
  assert.equal(terminalError, 'provider indisponível');
});
