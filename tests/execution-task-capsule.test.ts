import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionTaskCapsuleRuntime } from '../src/execution-task-capsule';

test('cria snapshot imutável do contexto da execução', () => {
  const runtime = new ExecutionTaskCapsuleRuntime(() => 1000, () => 'capsule-a');
  const capsule = runtime.create({
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Corrigir o login',
    projectId: 'project-a',
    providerId: 'openai',
    model: 'gpt-test',
    permissionLevel: 'ask',
  });

  assert.equal(capsule.id, 'capsule-a');
  assert.equal(capsule.objective, 'Corrigir o login');
  assert.equal(capsule.projectId, 'project-a');
  assert.equal(capsule.permissionLevel, 'ask');
});

test('repetição idêntica é idempotente e alteração posterior é rejeitada', () => {
  let id = 0;
  const runtime = new ExecutionTaskCapsuleRuntime(() => 1000, () => `capsule-${++id}`);
  const input = {
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Tarefa',
    providerId: 'openai',
    model: 'model-a',
    permissionLevel: 'safe' as const,
  };
  const first = runtime.create(input);
  const repeated = runtime.create(input);
  assert.equal(repeated.id, first.id);

  assert.throws(() => runtime.create({ ...input, model: 'model-b' }), /imutável/i);
});

test('não persiste segredo de credencial no contrato da cápsula', () => {
  const runtime = new ExecutionTaskCapsuleRuntime(() => 1000, () => 'capsule-a');
  const capsule = runtime.create({
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Tarefa',
    providerId: 'anthropic',
    model: 'claude-test',
    permissionLevel: 'read-only',
  });

  assert.equal('apiKey' in capsule, false);
  assert.equal('apiKeyId' in capsule, false);
});

test('restore ignora cápsulas inválidas e mantém as válidas', () => {
  const runtime = new ExecutionTaskCapsuleRuntime();
  runtime.restore([
    {
      id: 'capsule-a',
      chatId: 'chat-a',
      runId: 'run-a',
      objective: 'Tarefa',
      providerId: 'google',
      model: 'gemini-test',
      permissionLevel: 'ask',
      createdAt: 1000,
    },
    {
      id: '',
      chatId: '',
      runId: '',
      objective: '',
      providerId: '',
      model: '',
      permissionLevel: 'ask',
      createdAt: -1,
    },
  ]);

  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.get('chat-a', 'run-a')?.id, 'capsule-a');
});

test('removeChat preserva cápsulas de outros chats', () => {
  let id = 0;
  const runtime = new ExecutionTaskCapsuleRuntime(() => 1000 + id, () => `capsule-${++id}`);
  runtime.create({ chatId: 'chat-a', runId: 'run-a', objective: 'A', providerId: 'openai', model: 'a', permissionLevel: 'ask' });
  runtime.create({ chatId: 'chat-b', runId: 'run-b', objective: 'B', providerId: 'openai', model: 'b', permissionLevel: 'ask' });

  assert.equal(runtime.removeChat('chat-a'), 1);
  assert.equal(runtime.get('chat-a', 'run-a'), undefined);
  assert.ok(runtime.get('chat-b', 'run-b'));
});
