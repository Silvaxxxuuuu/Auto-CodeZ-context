import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicAdapter } from '../src/ai/providers/anthropic';
import { GoogleAdapter } from '../src/ai/providers/google';
import { OpenAIAdapter } from '../src/ai/providers/openai';

const config = {
  id: 'test-provider',
  displayName: 'Test Provider',
  apiKey: 'test-key',
  enabled: true,
};

async function withMockedFetch<T>(payload: unknown, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

test('OpenAI model discovery exposes reasoning only for reasoning families', async () => {
  const adapter = new OpenAIAdapter();
  const models = await withMockedFetch({
    data: [
      { id: 'gpt-5.6' },
      { id: 'gpt-5.1' },
      { id: 'gpt-4.1' },
      { id: 'o3-mini' },
    ],
  }, () => adapter.listModels(config));

  const byId = new Map(models.map((model) => [model.id, model]));
  assert.deepEqual(byId.get('gpt-5.6')?.reasoningLevels, ['low', 'normal', 'high', 'maximum']);
  assert.equal(byId.get('gpt-5.6')?.capabilities.includes('reasoning'), true);
  assert.deepEqual(byId.get('gpt-5.1')?.reasoningLevels, ['low', 'normal', 'high']);
  assert.equal(byId.get('gpt-4.1')?.capabilities.includes('reasoning'), false);
  assert.deepEqual(byId.get('gpt-4.1')?.reasoningLevels, ['normal']);
  assert.equal(byId.get('o3-mini')?.capabilities.includes('reasoning'), true);
});

test('Google model discovery distinguishes Gemini 3 and 2.5 thinking families', async () => {
  const adapter = new GoogleAdapter();
  const models = await withMockedFetch({
    models: [
      { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
    ],
  }, () => adapter.listModels(config));

  const byId = new Map(models.map((model) => [model.id, model]));
  assert.equal(models.length, 3);
  assert.equal(byId.get('gemini-3.1-pro-preview')?.capabilities.includes('reasoning'), true);
  assert.deepEqual(byId.get('gemini-3.1-pro-preview')?.reasoningLevels, ['low', 'normal', 'high', 'maximum']);
  assert.equal(byId.get('gemini-2.5-flash')?.capabilities.includes('reasoning'), true);
  assert.equal(byId.get('gemini-2.0-flash')?.capabilities.includes('reasoning'), false);
});

test('Anthropic model discovery exposes effort only for supported Claude families', async () => {
  const adapter = new AnthropicAdapter();
  const models = await withMockedFetch({
    data: [
      { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
      { id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' },
    ],
  }, () => adapter.listModels(config));

  const byId = new Map(models.map((model) => [model.id, model]));
  assert.equal(byId.get('claude-opus-4-6')?.capabilities.includes('reasoning'), true);
  assert.equal(byId.get('claude-sonnet-4-6')?.capabilities.includes('reasoning'), true);
  assert.deepEqual(byId.get('claude-sonnet-4-6')?.reasoningLevels, ['low', 'normal', 'high', 'maximum']);
  assert.equal(byId.get('claude-haiku-4-5')?.capabilities.includes('reasoning'), false);
  assert.equal(byId.get('claude-3-7-sonnet-20250219')?.capabilities.includes('reasoning'), false);
});
