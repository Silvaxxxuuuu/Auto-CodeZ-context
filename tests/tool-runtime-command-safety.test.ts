import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIToolCall } from '../src/ai/types';
import type { CommandRuntime } from '../src/agent/command-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import type { WorkspaceRuntime } from '../src/agent/workspace-runtime';

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

test('comando comum em unrestricted continua executando diretamente', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-normal', 'npm test'), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(result.output, 'ok');
  assert.deepEqual(commands.executed, ['npm test']);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});

test('leitura explícita de segredo via shell exige aprovação mesmo em unrestricted', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const pending = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-secret-read', 'type .env'), 'run-a');

  assert.equal(pending.ok, false);
  assert.equal(pending.pendingApproval, true);
  assert.ok(pending.approvalId);
  assert.deepEqual(commands.executed, []);

  const approved = await runtime.approve(pending.approvalId as string);
  assert.equal(approved.ok, true);
  assert.deepEqual(commands.executed, ['type .env']);
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

test('mutação Git crua exige aprovação em unrestricted e executa somente após aprovação', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const pending = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-git-add', 'git add src/main.ts'), 'run-a');

  assert.equal(pending.ok, false);
  assert.equal(pending.pendingApproval, true);
  assert.ok(pending.approvalId);
  assert.deepEqual(commands.executed, []);

  const approved = await runtime.approve(pending.approvalId as string);
  assert.equal(approved.ok, true);
  assert.deepEqual(commands.executed, ['git add src/main.ts']);
});

test('comando Git somente leitura permanece direto e template de env não é tratado como segredo', async () => {
  const commands = fakeCommands();
  const runtime = new ToolRuntime(fakeWorkspace(), undefined, undefined, undefined, commands.runtime);

  const status = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-git-status', 'git status'), 'run-a');
  const template = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('cmd-env-template', 'echo TOKEN= > .env.example'), 'run-a');

  assert.equal(status.ok, true);
  assert.equal(template.ok, true);
  assert.deepEqual(commands.executed, ['git status', 'echo TOKEN= > .env.example']);
});
