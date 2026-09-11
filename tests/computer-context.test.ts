import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerContextRuntime } from '../src/agent/computer-context';

test('ComputerContextRuntime exposes stable local computer context without reading arbitrary file contents', () => {
  const context = new ComputerContextRuntime().build();

  assert.match(context, /Local computer context:/);
  assert.match(context, /User: /);
  assert.match(context, /Home:/);
  assert.match(context, /Drives:/);
  assert.doesNotMatch(context, /password/i);
});
