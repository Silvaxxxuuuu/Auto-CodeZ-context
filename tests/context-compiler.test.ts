import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOCODEZ_AGENT_HANDBOOK, compileCapabilityGuidance, compileRuntimeFacts, ContextCompiler } from '../src/ai/context-compiler';

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
  assert.match(AUTOCODEZ_AGENT_HANDBOOK, /canonical capability guidance/i);
  assert.match(AUTOCODEZ_AGENT_HANDBOOK, /unrestricted: supported write and sensitive operations execute without an approval step/i);
});


test('ContextCompiler injects only available canonical capability metadata in relevance order', () => {
  const compiler = new ContextCompiler();
  const toolNames = ['run_command', 'create_file', 'start_process'];
  const messages = compiler.compile({
    runtimePlatform: 'Windows',
    runtimeDate: '2026-09-30',
    capabilityToolNames: toolNames,
    capabilityQuery: 'Execute os testes com run_command e depois inicie o servidor.',
  });

  assert.deepEqual(toolNames, ['run_command', 'create_file', 'start_process']);
  assert.equal(messages.length, 2);
  const guidance = messages[1].content;
  assert.match(guidance, /Canonical capability guidance/);
  assert.match(guidance, /run_command \[command\.run;/);
  assert.match(guidance, /start_process \[process\.start;/);
  assert.match(guidance, /Para testes, builds, inspeções e CLIs finitas/);
  assert.match(guidance, /Não usar shell para mutações de arquivo representadas por capabilities dedicadas/);
  assert.equal(guidance.includes('write_file [workspace.write_file;'), false);
  assert.ok(guidance.indexOf('run_command [command.run;') < guidance.indexOf('create_file [workspace.create_file;'));
});

test('canonical capability guidance obeys an explicit character budget deterministically', () => {
  const names = ['create_file', 'create_folder', 'write_file', 'run_command', 'start_process'];
  const first = compileCapabilityGuidance(names, 'criar arquivo e executar testes', 900);
  const second = compileCapabilityGuidance(names, 'criar arquivo e executar testes', 900);

  assert.equal(first, second);
  assert.ok(first);
  assert.ok(first.length <= 900);
  assert.match(first, /create_file \[workspace\.create_file;/);
});

test('ContextCompiler omits capability guidance when tools are disabled for the request', () => {
  const compiler = new ContextCompiler();
  const messages = compiler.compile({
    runtimePlatform: 'Linux',
    runtimeDate: '2026-09-30',
    disableTools: true,
    capabilityToolNames: [],
    capabilityQuery: 'execute npm test',
  });

  assert.equal(messages.some((message) => message.content.includes('Canonical capability guidance')), false);
});


test('ContextCompiler injects runtime facts as a separate bounded system layer', () => {
  const compiler = new ContextCompiler();
  const facts = [
    { key: 'OS', value: 'win32 10.0.19045 (x64)' },
    { key: 'Home', value: 'C:\\Users\\User' },
    { key: 'Desktop', value: 'C:\\Users\\User\\Desktop' },
  ];
  const messages = compiler.compile({
    runtimePlatform: 'Windows',
    runtimeDate: '2026-09-30',
    runtimeFacts: facts,
    projectContext: 'PROJECT',
  });

  assert.deepEqual(facts, [
    { key: 'OS', value: 'win32 10.0.19045 (x64)' },
    { key: 'Home', value: 'C:\\Users\\User' },
    { key: 'Desktop', value: 'C:\\Users\\User\\Desktop' },
  ]);
  assert.equal(messages.length, 3);
  assert.match(messages[1].content, /Runtime facts observed locally by Auto CodeZ/);
  assert.match(messages[1].content, /Desktop: C:\\Users\\User\\Desktop/);
  assert.equal(messages[2].content, 'Contexto do workspace atual:\nPROJECT');
  assert.equal(messages[2].content.includes('Runtime facts'), false);
});

test('runtime facts obey an explicit deterministic character budget', () => {
  const facts = [
    { key: 'OS', value: 'Windows' },
    { key: 'Home', value: 'C:\\Users\\User' },
    { key: 'Desktop', value: 'C:\\Users\\User\\Desktop' },
  ];
  const first = compileRuntimeFacts(facts, 150);
  const second = compileRuntimeFacts(facts, 150);

  assert.equal(first, second);
  assert.ok(first);
  assert.ok(first.length <= 150);
  assert.match(first, /OS: Windows/);
});

test('ContextCompiler omits runtime facts from lightweight turns', () => {
  const compiler = new ContextCompiler();
  const messages = compiler.compile({
    runtimePlatform: 'Windows',
    runtimeDate: '2026-09-30',
    lightweightTurn: true,
    runtimeFacts: [{ key: 'Desktop', value: 'C:\\Users\\User\\Desktop' }],
  });

  assert.equal(messages.some((message) => message.content.includes('Runtime facts observed locally')), false);
  assert.equal(messages.some((message) => message.content.includes('C:\\Users\\User\\Desktop')), false);
});
