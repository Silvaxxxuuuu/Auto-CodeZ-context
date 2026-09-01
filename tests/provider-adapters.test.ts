import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicAdapter } from '../src/ai/providers/anthropic';
import { GoogleAdapter } from '../src/ai/providers/google';
import { OpenAIAdapter } from '../src/ai/providers/openai';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'test-provider',
  displayName: 'Test Provider',
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1',
  enabled: true,
};

const request: AIRequest = {
  providerId: 'test-provider',
  model: 'test-model',
  messages: [{ role: 'user', content: 'Hello' }],
  intelligence: 'normal',
  toolsEnabled: true,
  tools: [{
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    requiresWriteAccess: false,
    requiresApproval: false,
  }],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function withMockedFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>, action: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function readBody(init?: RequestInit): Record<string, unknown> {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

test('OpenAI adapter sends the Responses API contract and parses the response', async () => {
  await withMockedFetch(async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = readBody(init);
    assert.equal(body.model, 'test-model');
    assert.ok(Array.isArray(body.input));
    assert.ok(Array.isArray(body.tools));
    return jsonResponse({ output_text: 'Hello from OpenAI', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
  }, async () => {
    const response = await new OpenAIAdapter().send(config, request);
    assert.equal(response.content, 'Hello from OpenAI');
    assert.deepEqual(response.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });
});

test('OpenAI adapter preserves streamed deltas and real Responses tool call events', async () => {
  await withMockedFetch(async (_input, init) => {
    const body = readBody(init);
    assert.equal(body.stream, true);
    return sseResponse([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello ' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'OpenAI' }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_1', name: 'read_file' } }),
      JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_item_1', output_index: 0, arguments: '{"path":"README.md"}' }),
      JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }),
      '[DONE]',
    ]);
  }, async () => {
    const events = [];
    for await (const event of new OpenAIAdapter().stream(config, request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'tool_call', 'complete']);
    assert.equal(events[1].text, 'Hello ');
    assert.equal(events[2].text, 'OpenAI');
    assert.equal(events[3].toolCall?.name, 'read_file');
    assert.deepEqual(events[3].toolCall?.input, { path: 'README.md' });
    assert.equal(events[4].response?.content, 'Hello OpenAI');
  });
});

test('Google adapter builds generateContent requests and parses tool calls', async () => {
  await withMockedFetch(async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'test-key');
    const body = readBody(init);
    assert.equal(body.contents instanceof Array, true);
    assert.equal(body.tools instanceof Array, true);
    const declarations = (body.tools as Array<{ functionDeclarations?: Array<{ parameters?: Record<string, unknown> }> }>)[0]?.functionDeclarations || [];
    assert.equal(declarations.length, 1);
    assert.equal('additionalProperties' in (declarations[0]?.parameters || {}), false);
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Hello Google' }, { functionCall: { name: 'read_file', id: 'call_2', args: { path: 'README.md' } } }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    });
  }, async () => {
    const response = await new GoogleAdapter().send(config, request);
    assert.equal(response.content, 'Hello Google');
    assert.equal(response.toolCalls?.[0]?.id, 'call_2');
    assert.deepEqual(response.toolCalls?.[0]?.input, { path: 'README.md' });
    assert.deepEqual(response.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });
});

test('Google adapter streams text and tool calls in provider order', async () => {
  await withMockedFetch(async (_input, init) => {
    const body = readBody(init);
    assert.equal(typeof body.contents, 'object');
    return sseResponse([
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Google' }, { functionCall: { name: 'read_file', id: 'call_3', args: { path: 'README.md' } } }] } }] }),
      JSON.stringify({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }),
      '[DONE]',
    ]);
  }, async () => {
    const events = [];
    for await (const event of new GoogleAdapter().stream(config, request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'tool_call', 'complete']);
    assert.equal(events[1].text, 'Hello ');
    assert.equal(events[2].text, 'Google');
    assert.equal(events[3].toolCall?.name, 'read_file');
    assert.equal(events[4].response?.content, 'Hello Google');
  });
});

test('Anthropic adapter builds Messages API requests and parses tool use', async () => {
  await withMockedFetch(async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'test-key');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const body = readBody(init);
    assert.equal(body.model, 'test-model');
    assert.ok(Array.isArray(body.messages));
    assert.ok(Array.isArray(body.tools));
    return jsonResponse({
      content: [{ type: 'text', text: 'Hello Anthropic' }, { type: 'tool_use', id: 'call_4', name: 'read_file', input: { path: 'README.md' } }],
      usage: { input_tokens: 5, output_tokens: 6 },
    });
  }, async () => {
    const response = await new AnthropicAdapter().send(config, request);
    assert.equal(response.content, 'Hello Anthropic');
    assert.equal(response.toolCalls?.[0]?.id, 'call_4');
    assert.deepEqual(response.toolCalls?.[0]?.input, { path: 'README.md' });
    assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 6, totalTokens: 11 });
  });
});

test('Anthropic adapter reconstructs streamed tool JSON and text', async () => {
  await withMockedFetch(async (_input, init) => {
    const body = readBody(init);
    assert.equal(body.stream, true);
    return sseResponse([
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } }),
      JSON.stringify({ type: 'content_block_start', content_block: { type: 'text' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Anthropic' } }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_5', name: 'read_file' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"README.md"}' } }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 4 } }),
      JSON.stringify({ type: 'message_stop' }),
      '[DONE]',
    ]);
  }, async () => {
    const events = [];
    for await (const event of new AnthropicAdapter().stream(config, request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'tool_call', 'complete']);
    assert.equal(events[1].text, 'Hello ');
    assert.equal(events[2].text, 'Anthropic');
    assert.equal(events[3].toolCall?.id, 'call_5');
    assert.deepEqual(events[3].toolCall?.input, { path: 'README.md' });
    assert.equal(events[4].response?.content, 'Hello Anthropic');
  });
});

test('provider adapters surface non-success HTTP responses', async () => {
  await withMockedFetch(async () => jsonResponse({ error: { message: 'invalid key' } }, 401), async () => {
    await assert.rejects(() => new OpenAIAdapter().send(config, request), /invalid key/);
    await assert.rejects(() => new GoogleAdapter().send(config, request), /invalid key/);
    await assert.rejects(() => new AnthropicAdapter().send(config, request), /invalid key/);
  });
});
