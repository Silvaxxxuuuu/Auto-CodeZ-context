import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUnifiedLocalModelChoices, findUnifiedLocalChoice } from '../src/ai/local-model-unified-selection';
import type { ManagedLocalRuntimeInfo } from '../src/ai/local-model-manager';
import type { LocalModelCompatibilityResult } from '../src/ai/local-model-runtime';

const excellent: LocalModelCompatibilityResult = {
  level: 'excellent',
  reasons: ['ok'],
  requirements: {},
};

function runtime(id: string, available: boolean, install = true): ManagedLocalRuntimeInfo {
  return {
    id,
    displayName: id,
    available,
    endpoint: `http://127.0.0.1/${id}`,
    operations: { install, cancelInstall: false, remove: false },
  };
}

function model(runtimeId: string, id: string, installed = false) {
  return {
    id,
    name: runtimeId === 'lm-studio' ? 'Qwen 3 4B · Q4_K_M' : 'Qwen 3 4B',
    runtimeId,
    installed,
    parameterSize: '4B',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    sizeBytes: 2.5 * 1024 ** 3,
    compatibility: excellent,
  };
}

test('unified local selection collapses equivalent models across runtimes', () => {
  const choices = buildUnifiedLocalModelChoices(
    [model('ollama', 'qwen3:4b'), model('lm-studio', 'qwen3-4b-q4-k-m')],
    [runtime('ollama', true), runtime('lm-studio', true)],
  );
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name, 'Qwen 3 4B');
  assert.equal(choices[0].variants.length, 2);
});

test('unified local selection prefers an installed backend over runtime priority', () => {
  const choices = buildUnifiedLocalModelChoices(
    [model('ollama', 'qwen3:4b'), model('lm-studio', 'qwen3-4b-q4-k-m', true)],
    [runtime('ollama', true), runtime('lm-studio', true)],
  );
  assert.equal(choices[0].selected.runtimeId, 'lm-studio');
  assert.equal(choices[0].installed, true);
});

test('unified local selection avoids an unavailable backend when another can install the same model', () => {
  const choices = buildUnifiedLocalModelChoices(
    [model('ollama', 'qwen3:4b'), model('lm-studio', 'qwen3-4b-q4-k-m')],
    [runtime('ollama', false), runtime('lm-studio', true)],
  );
  assert.equal(choices[0].selected.runtimeId, 'lm-studio');
});

test('Auto CodeZ Local becomes preferred only when it is operationally equivalent', () => {
  const choices = buildUnifiedLocalModelChoices(
    [model('ollama', 'qwen3:4b'), model('auto-codez-local', 'qwen3-4b-q4-k-m')],
    [runtime('ollama', true), runtime('auto-codez-local', true)],
  );
  assert.equal(choices[0].selected.runtimeId, 'auto-codez-local');
});

test('legacy provider/model identities resolve to the unified logical model', () => {
  const choices = buildUnifiedLocalModelChoices(
    [model('ollama', 'qwen3:4b'), model('lm-studio', 'qwen3-4b-q4-k-m')],
    [runtime('ollama', true), runtime('lm-studio', true)],
  );
  assert.equal(findUnifiedLocalChoice(choices, 'lm-studio', 'qwen3-4b-q4-k-m')?.id, 'qwen3:4b');
});
