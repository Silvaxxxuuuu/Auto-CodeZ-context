import assert from 'node:assert/strict';
import test from 'node:test';
import { SYSTEM_PROJECT_ID } from '../src/agent/command-runtime';
import { ExecutionPathScopeController, type ExecutionPathScopeToolConfigurator } from '../src/execution-path-scope-controller';
import { ExecutionPathScopeRuntime } from '../src/execution-path-scope';
import { ExecutionTaskCapsuleRuntime } from '../src/execution-task-capsule';

function createHarness(projectId?: string) {
  const capsules = new ExecutionTaskCapsuleRuntime(() => 100, () => 'capsule-a');
  capsules.create({
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Alterar código com escopo controlado',
    projectId,
    providerId: 'openai',
    model: 'gpt-test',
    permissionLevel: 'unrestricted',
  });
  const scopes = new ExecutionPathScopeRuntime(() => 200);
  const calls: Array<{ chatId: string; runId: string; projectId: string; allowedPaths: string[] }> = [];
  const tools: ExecutionPathScopeToolConfigurator = {
    configureExecutionAllowedPaths: async (chatId, runId, resolvedProjectId, allowedPaths) => {
      calls.push({ chatId, runId, projectId: resolvedProjectId, allowedPaths: [...allowedPaths] });
      return scopes.configure({ chatId, runId, projectId: resolvedProjectId, allowedPaths });
    },
  };
  return { capsules, scopes, calls, controller: new ExecutionPathScopeController(capsules, scopes, tools) };
}

test('controller resolve o projeto exclusivamente pela Task Capsule', async () => {
  const harness = createHarness('project-a');

  const scope = await harness.controller.configure({ chatId: 'chat-a', runId: 'run-a', allowedPaths: ['src', 'tests'] });

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].projectId, 'project-a');
  assert.equal(scope.projectId, 'project-a');
  assert.deepEqual(scope.allowedPaths, ['src', 'tests']);
});

test('execução sem projeto usa a identidade canônica do workspace de sistema', async () => {
  const harness = createHarness();

  const scope = await harness.controller.configure({ chatId: 'chat-a', runId: 'run-a', allowedPaths: ['.'] });

  assert.equal(harness.calls[0].projectId, SYSTEM_PROJECT_ID);
  assert.equal(scope.projectId, SYSTEM_PROJECT_ID);
});

test('controller falha fechado quando a Task Capsule não existe', async () => {
  const harness = createHarness('project-a');

  await assert.rejects(
    harness.controller.configure({ chatId: 'chat-a', runId: 'run-inexistente', allowedPaths: ['src'] }),
    /Task Capsule da execução não encontrada/i,
  );
  assert.equal(harness.calls.length, 0);
});

test('controller preserva a imutabilidade do escopo por execução', async () => {
  const harness = createHarness('project-a');
  await harness.controller.configure({ chatId: 'chat-a', runId: 'run-a', allowedPaths: ['src'] });

  const repeated = await harness.controller.configure({ chatId: 'chat-a', runId: 'run-a', allowedPaths: ['src'] });
  assert.deepEqual(repeated.allowedPaths, ['src']);

  await assert.rejects(
    harness.controller.configure({ chatId: 'chat-a', runId: 'run-a', allowedPaths: ['tests'] }),
    /imutável/i,
  );
});

test('list e removeChat permanecem isolados por chat e run', async () => {
  const harness = createHarness('project-a');
  await harness.controller.configure({ chatId: 'chat-a', runId: 'run-a', allowedPaths: ['src'] });
  harness.scopes.configure({ chatId: 'chat-b', runId: 'run-b', projectId: 'project-b', allowedPaths: ['lib'] });

  assert.equal(harness.controller.list({ chatId: 'chat-a' }).length, 1);
  assert.equal(harness.controller.list({ runId: 'run-b' })[0].chatId, 'chat-b');
  assert.equal(harness.controller.removeChat('chat-a'), 1);
  assert.equal(harness.controller.get('chat-a', 'run-a'), undefined);
  assert.equal(harness.controller.get('chat-b', 'run-b')?.projectId, 'project-b');
});
