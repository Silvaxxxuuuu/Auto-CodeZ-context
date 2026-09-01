import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDefaultModel } from '../src/ai/provider-manager';
import type { AIModel } from '../src/ai/types';

function model(id: string, providerId = 'google', capabilities: AIModel['capabilities'] = ['text', 'streaming', 'tools']): AIModel {
  return { id, name: id, providerId, capabilities };
}

test('Google selects an accessible Flash model before Pro when no model is specified', () => {
  const models = [model('gemini-3.1-pro-preview'), model('gemini-3.7-flash'), model('gemini-2.5-flash')];
  assert.equal(selectDefaultModel('google', models), 'gemini-3.7-flash');
});

test('OpenAI selects the strongest practical model through the generic policy', () => {
  const models = [model('gpt-5-mini', 'openai'), model('gpt-5.6', 'openai'), model('gpt-4.1', 'openai')];
  assert.equal(selectDefaultModel('openai', models), 'gpt-5.6');
});

test('Anthropic selects the strongest practical general model through the generic policy', () => {
  const models = [model('claude-haiku-5', 'anthropic'), model('claude-sonnet-5', 'anthropic'), model('claude-opus-4-8', 'anthropic')];
  assert.equal(selectDefaultModel('anthropic', models), 'claude-sonnet-5');
});

test('future providers use the generic policy without a provider-specific entry', () => {
  const models = [model('acme-4-preview', 'acme'), model('acme-3-lite', 'acme'), model('acme-4', 'acme')];
  assert.equal(selectDefaultModel('acme', models), 'acme-4');
});

test('default model selection falls back to the provider order when models tie', () => {
  const models = [model('custom-model-a'), model('custom-model-b')];
  assert.equal(selectDefaultModel('openai', models), 'custom-model-a');
});

test('default model selection returns undefined for an empty model list', () => {
  assert.equal(selectDefaultModel('google', []), undefined);
});
