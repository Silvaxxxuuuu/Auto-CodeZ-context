import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDefaultModel } from '../src/ai/model-selection';
import type { AIModel } from '../src/ai/types';

function model(id: string, capabilities: AIModel['capabilities'], name = id): AIModel {
  return { id, name, providerId: 'test', capabilities };
}

test('default selection prioritizes tools and streaming over a plain text model', () => {
  const models = [
    model('basic', ['text']),
    model('agent-ready', ['text', 'streaming', 'tools']),
  ];

  assert.equal(selectDefaultModel('test', models), 'agent-ready');
});

test('default selection penalizes preview and experimental models', () => {
  const models = [
    model('stable', ['text', 'streaming', 'tools']),
    model('next-preview', ['text', 'streaming', 'tools'], 'Next Preview'),
  ];

  assert.equal(selectDefaultModel('test', models), 'stable');
});

test('default selection avoids legacy and deprecated models when a modern option exists', () => {
  const models = [
    model('gpt-5', ['text', 'streaming', 'tools']),
    model('gpt-4-legacy', ['text', 'streaming', 'tools']),
    model('deprecated-model', ['text', 'streaming', 'tools']),
  ];

  assert.equal(selectDefaultModel('test', models), 'gpt-5');
});

test('selection remains deterministic when models have equal scores', () => {
  const models = [
    model('first', ['text', 'streaming']),
    model('second', ['text', 'streaming']),
  ];

  assert.equal(selectDefaultModel('test', models), 'first');
});

test('selection returns undefined for an empty model list', () => {
  assert.equal(selectDefaultModel('test', []), undefined);
});
