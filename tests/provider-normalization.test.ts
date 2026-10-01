import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicProviderToolCallId } from '../src/ai/provider-normalization';

test('provider tool identities are deterministic across equivalent argument key order', () => {
  const first = deterministicProviderToolCallId({
    providerId: 'google',
    model: 'gemini-test',
    toolName: 'write_file',
    arguments: { path: 'src/a.ts', options: { replace: false, mode: 'safe' } },
    ordinal: 0,
  });
  const second = deterministicProviderToolCallId({
    providerId: 'google',
    model: 'gemini-test',
    toolName: 'write_file',
    arguments: { options: { mode: 'safe', replace: false }, path: 'src/a.ts' },
    ordinal: 0,
  });

  assert.equal(first, second);
  assert.match(first, /^google_tool_[a-f0-9]{20}$/);
});

test('provider tool identities remain unique for duplicate calls in one provider response', () => {
  const base = {
    providerId: 'google',
    model: 'gemini-test',
    toolName: 'read_file',
    arguments: { path: 'README.md' },
  };
  const first = deterministicProviderToolCallId({ ...base, ordinal: 0 });
  const second = deterministicProviderToolCallId({ ...base, ordinal: 1 });

  assert.notEqual(first, second);
});
