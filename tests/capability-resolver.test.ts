import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityResolver } from '../src/ai/capability-resolver';
import type { AIModel } from '../src/ai/types';

const resolver = new CapabilityResolver();
const model: AIModel = {
  id: 'reasoning-model',
  name: 'Reasoning Model',
  providerId: 'test',
  capabilities: ['text', 'vision', 'tools', 'streaming', 'reasoning'],
  reasoningLevels: ['low', 'high', 'maximum'],
};

test('capability resolver checks individual and grouped capabilities', () => {
  assert.equal(resolver.supports(model, 'tools'), true);
  assert.equal(resolver.supports(model, 'audio'), false);
  assert.equal(resolver.supportsAny(model, ['audio', 'vision']), true);
  assert.equal(resolver.supportsAny(model, ['audio', 'video']), false);
  assert.equal(resolver.supportsAll(model, ['text', 'tools']), true);
  assert.equal(resolver.supportsAll(model, ['text', 'audio']), false);
});

test('available intelligence defaults to normal when a model has no explicit levels', () => {
  const plain: AIModel = { ...model, reasoningLevels: undefined };
  assert.deepEqual(resolver.availableIntelligence(plain), ['normal']);
});

test('requested intelligence is preserved when the model supports it', () => {
  assert.equal(resolver.resolveIntelligence(model, 'maximum'), 'maximum');
  assert.equal(resolver.resolveIntelligence(model, 'low'), 'low');
});

test('unsupported intelligence resolves to the closest available level', () => {
  assert.equal(resolver.resolveIntelligence(model, 'normal'), 'low');
  assert.equal(resolver.resolveIntelligence(model, 'high'), 'high');
});
