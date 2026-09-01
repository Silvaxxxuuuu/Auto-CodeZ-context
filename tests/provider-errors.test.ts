import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRequestError, classifyProviderError, formatProviderError, normalizeProviderError } from '../src/ai/provider-errors';

test('classifies quota errors independently of provider', () => {
  assert.equal(classifyProviderError(429, 'You exceeded your current quota'), 'quota');
  assert.equal(classifyProviderError(0, 'free tier quota exceeded'), 'quota');
});

test('classifies billing errors independently of provider', () => {
  assert.equal(classifyProviderError(402, 'payment required'), 'billing');
  assert.equal(classifyProviderError(0, 'You have no credits remaining'), 'billing');
});

test('classifies authentication and rate limit failures', () => {
  assert.equal(classifyProviderError(401, 'Unauthorized'), 'authentication');
  assert.equal(classifyProviderError(0, 'Invalid API key'), 'authentication');
  assert.equal(classifyProviderError(429, 'Too many requests'), 'rate_limit');
});

test('normalizes unknown adapter failures without losing the original detail', () => {
  const normalized = normalizeProviderError('Google AI', 'stream', new Error('quota exceeded'));
  assert.ok(normalized instanceof ProviderRequestError);
  assert.equal(normalized.provider, 'Google AI');
  assert.equal(normalized.operation, 'stream');
  assert.equal(normalized.message, 'quota exceeded');
  assert.equal(normalized.kind, 'quota');
});

test('formats provider failures for the application UI', () => {
  const quota = new ProviderRequestError('quota exceeded', 429, 'Google AI');
  const billing = new ProviderRequestError('no credits remaining', 402, 'OpenAI');
  assert.match(formatProviderError(quota), /Google AI:.*cota.*API key continua salva/i);
  assert.match(formatProviderError(billing), /OpenAI:.*créditos.*API key continua salva/i);
});
