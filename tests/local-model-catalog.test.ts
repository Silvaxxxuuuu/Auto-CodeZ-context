import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocalModelCatalogEntry, listLocalModelCatalog } from '../src/ai/local-model-catalog';
import { LocalModelManager } from '../src/ai/local-model-manager';

test('local model catalog exposes stable explicit Ollama tags with independent copies', () => {
  const first = listLocalModelCatalog('ollama');
  const second = listLocalModelCatalog('ollama');
  assert.ok(first.length >= 6);
  assert.ok(first.every((model) => model.runtimeId === 'ollama' && model.installed === false && model.sizeBytes && model.sizeBytes > 0));
  assert.ok(first.some((model) => model.id === 'qwen3:1.7b'));
  assert.notEqual(first, second);
  assert.notEqual(first[0].recommendedFor, second[0].recommendedFor);
});

test('local model catalog lookup is runtime scoped', () => {
  assert.equal(getLocalModelCatalogEntry('ollama', 'qwen3:4b')?.contextWindow, 256_000);
  assert.equal(getLocalModelCatalogEntry('other', 'qwen3:4b'), undefined);
  assert.equal(getLocalModelCatalogEntry('ollama', 'unknown:model'), undefined);
});

test('catalog metadata drives hardware blocking before installation', () => {
  const model = getLocalModelCatalogEntry('ollama', 'qwen3:8b');
  assert.ok(model);
  const manager = new LocalModelManager();
  const result = manager.evaluateModel(model, {
    totalRamBytes: 8 * 1024 ** 3,
    availableRamBytes: 6 * 1024 ** 3,
    freeDiskBytes: 100 * 1024 ** 3,
  });
  assert.equal(result.level, 'blocked');
  assert.ok(result.reasons.some((reason) => reason.includes('RAM total')));
});
