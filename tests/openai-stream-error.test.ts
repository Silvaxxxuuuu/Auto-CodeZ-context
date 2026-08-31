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

async function assertStreamError(sse: string, expected: string): Promise<void> {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${sse}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  try {
    await assert.rejects(
      async () => {
        for await (const event of new OpenAIAdapter().stream(config, request)) {
          assert.equal(event.type, 'start');
        }
      },
      (error: unknown) => error instanceof Error && error.message === expected,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('OpenAI stream exposes provider error details', async () => {
  await assertStreamError('{"type":"error","error":{"message":"invalid request for test"}}', 'invalid request for test');
});

test('OpenAI response.failed exposes response error details', async () => {
  await assertStreamError('{"type":"response.failed","response":{"error":{"message":"failed response for test"}}}', 'failed response for test');
});
