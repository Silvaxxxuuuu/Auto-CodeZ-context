import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDefaultModel } from '../src/ai/provider-manager';
import type { AIModel } from '../src/ai/types';

function model(id: string): AIModel {
  return { id, name: id, providerId: 'google', capabilities: ['text'] };
}

test('Google selects an accessible Flash model before Pro when no model is specified', () => {
  const models = [model('gemini-3.1-pro-preview'), model('gemini-3.7-flash'), model('gemini-2.5-flash')];
  assert.equal(selectDefaultModel('google', models), 'gemini-3.7-flash');
});

test('default model selection falls back to the provider order', () => {
  const models = [model('custom-model-a'), model('custom-model-b')];
  assert.equal(selectDefaultModel('openai', models), 'custom-model-a');
});

test('default model selection returns undefined for an empty model list', () => {
  assert.equal(selectDefaultModel('google', []), undefined);
});
