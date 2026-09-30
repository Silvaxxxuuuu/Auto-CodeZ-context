import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSafeResponseRetry } from '../src/response-retry';
import type { ChatRecord } from '../src/ai/types';
import type { ExecutionReport } from '../src/execution-report';

function chat(messages: ChatRecord['messages']): ChatRecord {
  return {
    id: 'chat-a', title: 'Retry', providerId: 'test', model: 'model',
    intelligence: 'normal', permissionLevel: 'ask', messages,
    createdAt: 1, updatedAt: 1,
  };
}

function report(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    chatId: 'chat-a', runId: 'run-a', state: 'completed',
    completionProof: 'unplanned', planArchived: false,
    steps: { total: 0, pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 },
    evidence: { tool: 0, test: 0, build: 0, file: 0, result: 0 },
    timeline: [],
    recordedTools: { observed: 0, completed: 0, failed: 0, waiting: 0, cancelled: 0, running: 0, tools: [] },
    ...overrides,
  };
}

test('safe retry removes only the selected tool-free final answer and reuses persisted user input', () => {
  const input = chat([
    { role: 'user', content: 'Explique isto.', attachments: [{
      id: 'a', kind: 'image', name: 'x.png', mediaType: 'image/png', size: 10,
      storageKey: 'hash', sha256: 'hash', createdAt: 1,
    }] },
    { role: 'assistant', content: 'Resposta antiga.', runId: 'run-a', createdAt: 2 },
  ]);
  const retry = prepareSafeResponseRetry(input, 'run-a', report());
  assert.equal(retry.content, 'Explique isto.');
  assert.equal(retry.attachments.length, 1);
  assert.equal(retry.chat.messages.length, 1);
  assert.equal(retry.chat.messages[0].role, 'user');
  assert.equal(input.messages.length, 2);
});

test('safe retry rejects any run with observed tools', () => {
  const input = chat([
    { role: 'user', content: 'Crie um arquivo.' },
    { role: 'assistant', content: 'Feito.', runId: 'run-a' },
  ]);
  assert.throws(() => prepareSafeResponseRetry(input, 'run-a', report({
    recordedTools: {
      observed: 1, completed: 1, failed: 0, waiting: 0, cancelled: 0, running: 0,
      tools: [{ toolCallId: 't1', toolName: 'create_file', phase: 'completed', updatedAt: 2 }],
    },
  })), /executaram ferramentas/i);
});

test('safe retry rejects ambiguous tool history even when report has no V2 tool record', () => {
  const input = chat([
    { role: 'user', content: 'Faça algo.' },
    { role: 'assistant', content: '', runId: 'run-a', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a' } }] },
    { role: 'tool', content: 'resultado', toolCallId: 't1', toolName: 'read_file' },
    { role: 'assistant', content: 'Resposta.', runId: 'run-a' },
  ]);
  assert.throws(() => prepareSafeResponseRetry(input, 'run-a', report()), /efeitos|ferramenta/i);
});

test('safe retry rejects mismatched report or unrelated run identity', () => {
  const input = chat([
    { role: 'user', content: 'Pergunta.' },
    { role: 'assistant', content: 'Resposta.', runId: 'run-a' },
  ]);
  assert.throws(() => prepareSafeResponseRetry(input, 'run-a', null), /comprovar/i);
  assert.throws(() => prepareSafeResponseRetry(input, 'run-b', report()), /comprovar|não encontrada/i);
});


test('safe retry rejects an older assistant response when later chat history exists', () => {
  const input = chat([
    { role: 'user', content: 'Pergunta antiga.' },
    { role: 'assistant', content: 'Resposta antiga.', runId: 'run-a' },
    { role: 'user', content: 'Pergunta nova.' },
    { role: 'assistant', content: 'Resposta nova.', runId: 'run-b' },
  ]);
  assert.throws(() => prepareSafeResponseRetry(input, 'run-a', report()), /mais recente/i);
});
