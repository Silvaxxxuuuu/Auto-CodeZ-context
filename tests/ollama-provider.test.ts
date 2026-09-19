import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaAdapter } from '../src/ai/providers/ollama';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

function config(): AIProviderConfig {
  return { id: 'ollama', displayName: 'Ollama', apiKey: '', enabled: true };
}

const request: AIRequest = {
  providerId: 'ollama',
  model: 'gpt-oss:20b',
  messages: [{ role: 'user', content: 'Leia README.md' }],
  intelligence: 'high',
  toolsEnabled: true,
  tools: [{
    name: 'read_file',
    description: 'Read one file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    requiresWriteAccess: false,
    requiresApproval: false,
  }],
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function ndjsonResponse(values: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
}

async function withMockedFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try { await action(); } finally { globalThis.fetch = originalFetch; }
}

function bodyFrom(init?: RequestInit): Record<string, unknown> {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

test('Ollama model discovery uses native tags/show metadata and excludes non-completion models', async () => {
  const adapter = new OllamaAdapter();
  await withMockedFetch(async (input, init) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:11434/api/tags') {
      return jsonResponse({ models: [{ model: 'gpt-oss:20b' }, { model: 'embedding-only' }] });
    }
    if (url === 'http://127.0.0.1:11434/api/show') {
      const body = bodyFrom(init);
      if (body.model === 'gpt-oss:20b') {
        return jsonResponse({
          capabilities: ['completion', 'tools', 'thinking', 'vision'],
          model_info: { 'gptoss.context_length': 131072 },
        });
      }
      return jsonResponse({ capabilities: ['embedding'] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    const models = await adapter.listModels(config());
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, 'gpt-oss:20b');
    assert.equal(models[0]?.contextWindow, 131072);
    assert.deepEqual(models[0]?.capabilities, ['text', 'streaming', 'tools', 'reasoning', 'vision']);
    assert.deepEqual(models[0]?.reasoningLevels, ['low', 'normal', 'high']);
  });
});

test('Ollama chat sends tools and reasoning without exposing the model thinking trace', async () => {
  const adapter = new OllamaAdapter();
  await withMockedFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ model: 'gpt-oss:20b' }] });
    if (url.endsWith('/api/show')) return jsonResponse({ capabilities: ['completion', 'tools', 'thinking'] });
    if (url.endsWith('/api/chat')) {
      const body = bodyFrom(init);
      assert.equal(body.stream, false);
      assert.equal(body.think, 'high');
      assert.ok(Array.isArray(body.tools));
      return jsonResponse({
        message: {
          role: 'assistant',
          content: 'Vou ler o arquivo.',
          thinking: 'raciocínio privado que não deve aparecer',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
        },
        prompt_eval_count: 7,
        eval_count: 5,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    await adapter.listModels(config());
    const response = await adapter.send(config(), request);
    assert.equal(response.content, 'Vou ler o arquivo.');
    assert.equal(response.content.includes('raciocínio privado'), false);
    assert.equal(response.toolCalls?.[0]?.name, 'read_file');
    assert.deepEqual(response.toolCalls?.[0]?.input, { path: 'README.md' });
    assert.deepEqual(response.usage, { inputTokens: 7, outputTokens: 5, totalTokens: 12 });
  });
});

test('Ollama NDJSON streaming ignores thinking chunks and emits terminal tool calls', async () => {
  const adapter = new OllamaAdapter();
  await withMockedFetch(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ model: 'gpt-oss:20b' }] });
    if (url.endsWith('/api/show')) return jsonResponse({ capabilities: ['completion', 'tools', 'thinking'] });
    if (url.endsWith('/api/chat')) {
      const body = bodyFrom(init);
      assert.equal(body.stream, true);
      return ndjsonResponse([
        { message: { role: 'assistant', thinking: 'não expor' }, done: false },
        { message: { role: 'assistant', content: 'Olá ' }, done: false },
        { message: { role: 'assistant', content: 'mundo' }, done: false },
        { message: { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }] }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 3, eval_count: 4 },
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    await adapter.listModels(config());
    const events = [];
    for await (const event of adapter.stream(config(), request)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'tool_call', 'complete']);
    assert.equal(events.some((event) => event.text?.includes('não expor')), false);
    assert.equal(events[1]?.text, 'Olá ');
    assert.equal(events[2]?.text, 'mundo');
    assert.deepEqual(events[3]?.toolCall?.input, { path: 'README.md' });
    assert.equal(events[4]?.response?.content, 'Olá mundo');
    assert.deepEqual(events[4]?.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });
});
