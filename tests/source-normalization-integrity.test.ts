import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAISource } from '../src/ai/source-normalization';

test('source normalization fails closed on unknown provenance labels', () => {
  assert.equal(normalizeAISource({
    title: 'Tentativa inválida',
    url: 'https://example.com/docs',
    origin: 'trusted-by-attacker',
  }), undefined);
});

test('source normalization accepts only the two canonical provenance labels', () => {
  assert.equal(normalizeAISource({ title: 'Web', url: 'https://web.example/docs', origin: 'autocodez-web' })?.origin, 'autocodez-web');
  assert.equal(normalizeAISource({ title: 'Native', url: 'https://provider.example/docs', origin: 'provider-native' })?.origin, 'provider-native');
});
