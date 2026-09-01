import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicAdapter } from '../src/ai/providers/anthropic';
import { GoogleAdapter } from '../src/ai/providers/google';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

const request: AIRequest = {
  providerId: 'test',
  model: 'test-model',
  messages: [{ role: 'user', content: 'Hello' }],
  intelligence: 'normal',
  toolsEnabled: false,
};

async function assertStreamingError(
  adapter: { stream: (config: AIProviderConfig, request: AIRequest) => AsyncGenerator<{ type: string }> },
  config: AIProviderConfig,
  body: string,
  expected: string,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

  try {
    const events: string[] = [];
    await assert.rejects(
      async () => {
        for await (const event of adapter.stream(config, request)) events.push(event.type);
      },
      (error: unknown) => error instanceof Error && error.message === expected,
    );
    assert.deepEqual(events, ['start']);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('Google stream exposes provider error details', async () => {
  await assertStreamingError(
    new GoogleAdapter(),
    { id: 'google', displayName: 'Google AI', apiKey: 'test-key', enabled: true },
    `data: ${JSON.stringify({ error: { message: 'Google stream failed for test' } })}\n\n`,
    'Google stream failed for test',
  );
});

test('Anthropic stream exposes provider error details', async () => {
  await assertStreamingError(
    new AnthropicAdapter(),
    { id: 'anthropic', displayName: 'Anthropic', apiKey: 'test-key', enabled: true },
    `data: ${JSON.stringify({ type: 'error', error: { message: 'Anthropic stream failed for test' } })}\n\n`,
    'Anthropic stream failed for test',
  );
});

test('Google and Anthropic surface HTTP error bodies', async () => {
  const originalFetch = globalThis.fetch;
  const errorBody = JSON.stringify({ error: { message: 'authentication failed for test' } });
  globalThis.fetch = async () => new Response(errorBody, {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await assert.rejects(
      () => new GoogleAdapter().stream({ id: 'google', displayName: 'Google AI', apiKey: 'test-key', enabled: true }, request).next(),
      /authentication failed for test/,
    );
    await assert.rejects(
      () => new AnthropicAdapter().stream({ id: 'anthropic', displayName: 'Anthropic', apiKey: 'test-key', enabled: true }, request).next(),
      /authentication failed for test/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
