import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAdapter } from '../src/ai/providers/openai';
import { AnthropicAdapter } from '../src/ai/providers/anthropic';
import { GoogleAdapter } from '../src/ai/providers/google';
import { OllamaAdapter } from '../src/ai/providers/ollama';
import { OpenAICompatibleAdapter } from '../src/ai/providers/openai-compatible';
import { AzureOpenAIAdapter } from '../src/ai/providers/azure-openai';
import type { AIAttachment, AIProviderConfig, AIRequest } from '../src/ai/types';

const attachment: AIAttachment = {
  id: 'att-1',
  kind: 'image',
  name: 'screen.png',
  mediaType: 'image/png',
  size: 5,
  storageKey: 'a'.repeat(64),
  sha256: 'a'.repeat(64),
  createdAt: 1,
  dataBase64: 'aW1hZ2U=',
};

function request(providerId: string, model: string): AIRequest {
  return {
    providerId,
    model,
    messages: [{ role: 'user', content: 'Analise a imagem.', attachments: [attachment] }],
    intelligence: 'normal',
    toolsEnabled: false,
  };
}

function config(id: string, baseUrl: string): AIProviderConfig {
  return { id, displayName: id, apiKey: 'key', baseUrl, enabled: true };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function withFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  action: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try { await action(); } finally { globalThis.fetch = original; }
}

function body(init?: RequestInit): Record<string, unknown> {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

test('OpenAI Responses sends hydrated image bytes as input_image data URL', async () => {
  await withFetch(async (_input, init) => {
    const payload = body(init);
    const input = payload.input as Array<Record<string, unknown>>;
    const user = input.find((item) => item.role === 'user');
    const content = user?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'input_image');
    assert.equal(image?.image_url, 'data:image/png;base64,aW1hZ2U=');
    return jsonResponse({ output_text: 'ok', output: [] });
  }, async () => {
    await new OpenAIAdapter().send(config('openai', 'https://openai.test/v1'), request('openai', 'gpt-5.6'));
  });
});

test('Anthropic sends hydrated image bytes as a base64 image content block', async () => {
  await withFetch(async (_input, init) => {
    const payload = body(init);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image');
    assert.deepEqual(image?.source, { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' });
    return jsonResponse({ content: [{ type: 'text', text: 'ok' }], usage: {} });
  }, async () => {
    await new AnthropicAdapter().send(config('anthropic', 'https://anthropic.test/v1'), request('anthropic', 'claude-sonnet-5'));
  });
});

test('Gemini sends hydrated image bytes as inlineData', async () => {
  await withFetch(async (_input, init) => {
    const payload = body(init);
    const contents = payload.contents as Array<Record<string, unknown>>;
    const parts = contents[0]?.parts as Array<Record<string, unknown>>;
    const image = parts.find((item) => item.inlineData);
    assert.deepEqual(image?.inlineData, { mimeType: 'image/png', data: 'aW1hZ2U=' });
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  }, async () => {
    await new GoogleAdapter().send(config('google', 'https://google.test/v1beta'), request('google', 'gemini-3-pro'));
  });
});

test('Ollama sends hydrated image bytes using the native message images array', async () => {
  await withFetch(async (_input, init) => {
    const payload = body(init);
    const messages = payload.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0]?.images, ['aW1hZ2U=']);
    return jsonResponse({ message: { content: 'ok' }, done: true });
  }, async () => {
    await new OllamaAdapter().send(config('ollama', 'http://127.0.0.1:11434'), request('ollama', 'gemma3:4b'));
  });
});

test('OpenAI-compatible providers send hydrated images using image_url content parts', async () => {
  const adapter = new OpenAICompatibleAdapter({
    id: 'local-test',
    displayName: 'Local Test',
    baseUrl: 'http://127.0.0.1:1234/v1',
    toolsByDefault: false,
  });
  await withFetch(async (_input, init) => {
    const payload = body(init);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'image_url');
    assert.deepEqual(image?.image_url, { url: 'data:image/png;base64,aW1hZ2U=' });
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  }, async () => {
    await adapter.send(config('local-test', 'http://127.0.0.1:1234/v1'), request('local-test', 'vision-model'));
  });
});

test('Azure Foundry Responses sends hydrated images as input_image parts', async () => {
  await withFetch(async (_input, init) => {
    const payload = body(init);
    const input = payload.input as Array<Record<string, unknown>>;
    const user = input.find((item) => item.role === 'user');
    const content = user?.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === 'input_image');
    assert.equal(image?.image_url, 'data:image/png;base64,aW1hZ2U=');
    return jsonResponse({ output_text: 'ok', output: [] });
  }, async () => {
    await new AzureOpenAIAdapter().send(
      config('azure-openai', 'https://resource.services.ai.azure.com'),
      request('azure-openai', 'gpt-5.6'),
    );
  });
});
