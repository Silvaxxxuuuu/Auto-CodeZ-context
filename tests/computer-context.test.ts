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


test('ComputerContextRuntime exposes ordered structured facts independently from legacy prose', () => {
  const runtime = new ComputerContextRuntime();
  const facts = runtime.buildFacts();

  assert.ok(facts.length >= 5);
  assert.deepEqual(facts.slice(0, 4).map((fact) => fact.key), ['OS', 'User', 'Shell', 'Drives']);
  assert.equal(facts.some((fact) => fact.key === 'Home'), true);
  assert.equal(facts.every((fact) => fact.key.trim().length > 0 && fact.value.trim().length > 0), true);
});
