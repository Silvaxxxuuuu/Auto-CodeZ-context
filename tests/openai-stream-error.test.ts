import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAdapter } from '../src/ai/providers/openai';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'openai',
  displayName: 'OpenAI',
  apiKey: 'test-key',
  enabled: true,
};

const request: AIRequest = {
  providerId: 'openai',
  model: 'gpt-5.6',
  messages: [{ role: 'user', content: 'Hello' }],
  intelligence: 'normal',
  toolsEnabled: false,
};

test('OpenAI stream exposes provider error details', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"error","error":{"message":"invalid request for test"}}\\n\\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  try {
    const events = [];
    for await (const event of new OpenAIAdapter().stream(config, request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start']);
  } catch (error) {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message, 'invalid request for test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI response.failed exposes response error details', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"response.failed","response":{"error":{"message":"failed response for test"}}}\\n\\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  try {
    const events = [];
    for await (const event of new OpenAIAdapter().stream(config, request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start']);
  } catch (error) {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message, 'failed response for test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
