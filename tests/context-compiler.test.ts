import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOCODEZ_AGENT_HANDBOOK, ContextCompiler } from '../src/ai/context-compiler';

test('ContextCompiler preserves deterministic system-context ordering', () => {
  const compiler = new ContextCompiler();
  const messages = compiler.compile({
    runtimePlatform: 'Windows',
    runtimeDate: '2026-09-30',
    memoryContext: 'MEMORY',
    providerInstructions: ['PROVIDER'],
    webContext: 'WEB',
    projectContext: 'PROJECT',
    compactedHistory: true,
    groundedAnswerOnly: true,
    disableTools: true,
  });

  assert.equal(messages.length, 9);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, `${AUTOCODEZ_AGENT_HANDBOOK}\n\nRuntime OS: Windows.\nRuntime date: 2026-09-30.`);
  assert.equal(messages[1].content, 'MEMORY');
  assert.equal(messages[2].content, 'PROVIDER');
  assert.equal(messages[3].content, 'WEB');
  assert.match(messages[4].content, /grounding Web deste turno/i);
  assert.equal(messages[5].content, 'Contexto do workspace atual:\nPROJECT');
  assert.match(messages[6].content, /compactou resultados/i);
  assert.match(messages[7].content, /consulta informativa já grounded/i);
  assert.match(messages[8].content, /regeneração textual segura/i);
});

test('ContextCompiler keeps lightweight turns isolated from project context', () => {
  const compiler = new ContextCompiler();
  const messages = compiler.compile({
    runtimePlatform: 'Linux',
    runtimeDate: '2026-09-30',
    lightweightTurn: true,
    projectContext: 'PRIVATE PROJECT CONTEXT',
  });

  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /turno atual é uma saudação/i);
  assert.equal(messages.some((message) => message.content.includes('PRIVATE PROJECT CONTEXT')), false);
});

test('ContextCompiler ignores blank provider instructions and does not mutate inputs', () => {
  const compiler = new ContextCompiler();
  const providerInstructions = ['  ', 'Provider rule'];
  const input = {
    runtimePlatform: 'macOS',
    runtimeDate: '2026-09-30',
    providerInstructions,
  };

  const first = compiler.compile(input);
  const second = compiler.compile(input);

  assert.deepEqual(first, second);
  assert.deepEqual(providerInstructions, ['  ', 'Provider rule']);
  assert.equal(first.length, 2);
  assert.equal(first[1].content, 'Provider rule');
});

test('Agent Handbook retains core evidence and security invariants after extraction', () => {
  assert.match(AUTOCODEZ_AGENT_HANDBOOK, /Never claim an operation succeeded unless a tool result confirms success/i);
  assert.match(AUTOCODEZ_AGENT_HANDBOOK, /Do not bypass or simulate approval/i);
  assert.match(AUTOCODEZ_AGENT_HANDBOOK, /Use run_command for tests, builds/i);
  assert.match(AUTOCODEZ_AGENT_HANDBOOK, /unrestricted: supported write and sensitive operations execute without an approval step/i);
});
