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

async function assertStreamError(event: Record<string, unknown>, expected: string): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

  try {
    const events: string[] = [];
    await assert.rejects(
      async () => {
        for await (const streamEvent of new OpenAIAdapter().stream(config, request)) {
          events.push(streamEvent.type);
        }
      },
      (error: unknown) => error instanceof Error && error.message === expected,
    );
    assert.deepEqual(events, ['start']);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('OpenAI stream exposes provider error details', async () => {
  await assertStreamError(
    { type: 'error', error: { message: 'invalid request for test' } },
    'invalid request for test',
  );
});

test('OpenAI response.failed exposes response error details', async () => {
  await assertStreamError(
    { type: 'response.failed', response: { error: { message: 'failed response for test' } } },
    'failed response for test',
  );
});
