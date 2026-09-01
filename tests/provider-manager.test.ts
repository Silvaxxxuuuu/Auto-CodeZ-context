import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDefaultModel } from '../src/ai/provider-manager';
import type { AIModel } from '../src/ai/types';

function model(id: string, providerId = 'google', capabilities: AIModel['capabilities'] = ['text', 'streaming', 'tools']): AIModel {
  return { id, name: id, providerId, capabilities };
}

test('model selection prefers practical capabilities over a weaker model', () => {
  const models = [
    model('model-basic', 'google', ['text']),
    model('model-full', 'google', ['text', 'streaming', 'tools']),
  ];
  assert.equal(selectDefaultModel('google', models), 'model-full');
});

test('OpenAI uses the same generic selection policy', () => {
  const models = [model('gpt-5-mini', 'openai', ['text']), model('gpt-5', 'openai', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('openai', models), 'gpt-5');
});

test('Anthropic uses the same generic selection policy', () => {
  const models = [model('claude-sonnet', 'anthropic', ['text']), model('claude-opus', 'anthropic', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('anthropic', models), 'claude-opus');
});

test('future providers use the generic policy without a provider-specific entry', () => {
  const models = [model('acme-4-preview', 'acme', ['text', 'streaming', 'tools']), model('acme-4', 'acme', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('acme', models), 'acme-4');
});

test('preview and lightweight variants lose priority to a stable general model', () => {
  const models = [
    model('gemini-3.7-flash-preview', 'google'),
    model('gemini-3.6-flash-lite', 'google'),
    model('gemini-3.5-flash', 'google'),
  ];
  assert.equal(selectDefaultModel('google', models), 'gemini-3.5-flash');
});

test('default model selection preserves provider order when scores tie', () => {
  const models = [model('custom-model-a'), model('custom-model-b')];
  assert.equal(selectDefaultModel('openai', models), 'custom-model-a');
});

test('default model selection returns undefined for an empty model list', () => {
  assert.equal(selectDefaultModel('google', []), undefined);
});
