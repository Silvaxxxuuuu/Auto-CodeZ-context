import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
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

function createRuntime(stream: NonNullable<AIProviderAdapter['stream']>, displayName = 'Mock'): ChatRuntime {
  const adapter: AIProviderAdapter = {
    id: 'mock',
    displayName,
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
  const runtime = createRuntime(async function* (): AsyncGenerator<AIStreamEvent> {
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
  const runtime = createRuntime(async function* (): AsyncGenerator<AIStreamEvent> {
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
  assert.equal(terminalError, 'Mock: provider indisponível');
});

test('formats quota failures without binding the runtime to a specific provider', async () => {
  const runtime = createRuntime(async function* (): AsyncGenerator<AIStreamEvent> {
    yield { type: 'start' };
    throw new Error('You exceeded your current quota.');
  }, 'Google AI');

  const events: AIStreamEvent[] = [];
  for await (const event of runtime.stream({ ...config, displayName: 'Google AI' }, chat)) events.push(event);

  const error = events.find((event) => event.type === 'error')?.error || '';
  assert.match(error, /Google AI:.*cota.*API key continua salva/i);
});

test('formats billing failures without exposing provider billing internals', async () => {
  const runtime = createRuntime(async function* (): AsyncGenerator<AIStreamEvent> {
    yield { type: 'start' };
    throw new Error('You have no credits remaining.');
  }, 'OpenAI');

  const events: AIStreamEvent[] = [];
  for await (const event of runtime.stream({ ...config, displayName: 'OpenAI' }, chat)) events.push(event);

  const error = events.find((event) => event.type === 'error')?.error || '';
  assert.match(error, /OpenAI:.*créditos.*API key continua salva/i);
});
