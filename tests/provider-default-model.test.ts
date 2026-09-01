import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDefaultModel } from '../src/ai/provider-manager';
import type { AIModel } from '../src/ai/types';

function model(id: string): AIModel {
  return { id, name: id, providerId: 'google', capabilities: ['text'] };
}

test('Google prefers Gemini 2.5 Flash over newer thinking models by default', () => {
  const selected = selectDefaultModel('google', [model('gemini-3.1-pro'), model('gemini-2.5-flash'), model('gemini-2.5-pro')]);
  assert.equal(selected?.id, 'gemini-2.5-flash');
});

test('Google falls back to Gemini 2.5 before using the first model', () => {
  const selected = selectDefaultModel('google', [model('gemini-3.1-pro'), model('gemini-2.5-pro')]);
  assert.equal(selected?.id, 'gemini-2.5-pro');
});

test('Other providers preserve their existing first-model default', () => {
  const selected = selectDefaultModel('openai', [model('first'), model('second')]);
  assert.equal(selected?.id, 'first');
});
