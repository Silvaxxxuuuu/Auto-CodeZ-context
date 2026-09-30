import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIToolCall } from '../src/ai/types';
import type { CommandRuntime } from '../src/agent/command-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import type { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ActivityRuntime } from '../src/agent/activity-runtime';

function call(id: string, command: string): AIToolCall {
  return { id, name: 'run_command', input: { command } };
}

function fakeWorkspace(): WorkspaceRuntime {
  return {
    exists: async () => false,
    readFile: async () => '',
    writeFile: async () => {},
    createFile: async () => {},
    deleteFile: async () => {},
    renameFile: async () => {},
    searchFiles: async (): Promise<string[]> => [],
  } as unknown as WorkspaceRuntime;
}

function fakeCommands() {
  const executed: string[] = [];
  const runtime = {
    run: async (_projectId: string, command: string) => {
      executed.push(command);
      return {
        command,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        startedAt: 100,
        finishedAt: 101,
        durationMs: 1,
      };
    },
  } as unknown as CommandRuntime;
  return { runtime, executed };
}

test('comando comum em unrestricted executa diretamente sem approval', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-normal', 'npm test'), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(result.pendingApproval, undefined);
  assert.equal(result.output, 'ok');
  assert.deepEqual(commands.executed, ['npm test']);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});

test('leitura explícita de segredo via shell em unrestricted executa sem approval', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-secret-read', 'type .env'), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(result.pendingApproval, undefined);
  assert.deepEqual(commands.executed, ['type .env']);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});

test('mutação direta de segredo via shell é bloqueada antes da execução', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-secret-write', 'echo TOKEN=x > .env'), 'run-a');

  assert.equal(result.ok, false);
  assert.equal(result.pendingApproval, undefined);
  assert.match(result.error ?? '', /política de segurança/i);
  assert.match(result.error ?? '', /variáveis de ambiente/i);
  assert.deepEqual(commands.executed, []);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});

test('mutação direta de metadados Git via shell é bloqueada', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-git-config-write', 'echo x > .git/config'), 'run-a');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /metadados internos do Git/i);
  assert.deepEqual(commands.executed, []);
});

test('mutação Git crua em unrestricted não cria approval quando não há deny de segurança', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-git-add', 'git add src/main.ts'), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(result.pendingApproval, undefined);
  assert.deepEqual(commands.executed, ['git add src/main.ts']);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});

test('Git somente leitura e template de env executam direto em unrestricted sem classificar template como segredo', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const status = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-git-status', 'git status'), 'run-a');
  assert.equal(status.ok, true);
  assert.equal(status.pendingApproval, undefined);

  const template = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-env-template', 'echo TOKEN= > .env.example'), 'run-a');
  assert.equal(template.ok, true);
  assert.equal(template.pendingApproval, undefined);
  assert.deepEqual(commands.executed, ['git status', 'echo TOKEN= > .env.example']);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});


test('run_command emits a V2 running lifecycle and returns the same execution identity on success', async () => {
  const commands = fakeCommands();
  const activity = new ActivityRuntime();
  const structured: Array<{ phase: string; executionId?: string; capabilityId?: string; toolCallId?: string }> = [];
  activity.subscribeStructured((event) => structured.push(event));
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, activity, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-life', 'npm test'), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(result.executionId, 'command:run-a:cmd-life');
  assert.equal(result.commandResult?.executionId, 'command:run-a:cmd-life');
  assert.deepEqual(structured, [{
    phase: 'running',
    executionId: 'command:run-a:cmd-life',
    capabilityId: 'command.run',
    toolCallId: 'cmd-life',
  }]);
});

test('run_command retains execution identity when the shell runtime fails', async () => {
  const activity = new ActivityRuntime();
  const structured: Array<{ phase: string; executionId?: string }> = [];
  activity.subscribeStructured((event) => structured.push({ phase: event.phase, executionId: event.executionId }));
  const commands = {
    run: async () => { throw new Error('shell failed'); },
  } as unknown as CommandRuntime;
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, activity, undefined, commands);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-fail', 'npm test'), 'run-a');

  assert.equal(result.ok, false);
  assert.equal(result.executionId, 'command:run-a:cmd-fail');
  assert.deepEqual(structured, [{ phase: 'running', executionId: 'command:run-a:cmd-fail' }]);
});
