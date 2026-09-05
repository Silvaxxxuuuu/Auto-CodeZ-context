import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIToolCall } from '../src/ai/types';
import { ToolRuntime } from '../src/agent/tool-runtime';
import type { WorkspaceRuntime } from '../src/agent/workspace-runtime';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

function fakeWorkspace() {
  let reads = 0;
  let writes = 0;
  const workspace = {
    exists: async () => true,
    readFile: async () => {
      reads += 1;
      return 'secret-value';
    },
    writeFile: async () => {
      writes += 1;
    },
    createFile: async () => {
      writes += 1;
    },
    deleteFile: async () => {
      writes += 1;
    },
    renameFile: async () => {
      writes += 1;
    },
    searchFiles: async (): Promise<string[]> => [],
  } as unknown as WorkspaceRuntime;
  return { workspace, reads: () => reads, writes: () => writes };
}

test('leitura comum em unrestricted continua executando diretamente', async () => {
  const fake = fakeWorkspace();
  const runtime = new ToolRuntime(fake.workspace);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('read-normal', 'read_file', { path: 'src/main.ts' }), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(result.output, 'secret-value');
  assert.equal(fake.reads(), 1);
  assert.equal(runtime.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
});

test('leitura de segredo exige aprovação mesmo em unrestricted e só lê depois da decisão', async () => {
  const fake = fakeWorkspace();
  const runtime = new ToolRuntime(fake.workspace);

  const pending = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('read-secret', 'read_file', { path: '.env' }), 'run-a');

  assert.equal(pending.ok, false);
  assert.equal(pending.pendingApproval, true);
  assert.ok(pending.approvalId);
  assert.equal(fake.reads(), 0);

  const approved = await runtime.approve(pending.approvalId!);
  assert.equal(approved.ok, true);
  assert.equal(approved.output, 'secret-value');
  assert.equal(fake.reads(), 1);
});

test('mutação de segredo é bloqueada antes de preview ou escrita inclusive em unrestricted', async () => {
  const fake = fakeWorkspace();
  const runtime = new ToolRuntime(fake.workspace);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('write-secret', 'write_file', { path: '.env', content: 'TOKEN=new' }), 'run-a');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /política de segurança do workspace/i);
  assert.equal(result.pendingApproval, undefined);
  assert.equal(fake.reads(), 0);
  assert.equal(fake.writes(), 0);
});

test('metadados Git não podem ser alterados por file tools', async () => {
  const fake = fakeWorkspace();
  const runtime = new ToolRuntime(fake.workspace);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('write-git', 'write_file', { path: '.git/config', content: '[core]' }), 'run-a');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /metadados internos do Git/i);
  assert.equal(fake.reads(), 0);
  assert.equal(fake.writes(), 0);
});

test('template de env continua fora da proteção de segredo', async () => {
  const fake = fakeWorkspace();
  const runtime = new ToolRuntime(fake.workspace);

  const result = await runtime.execute('chat-a', 'project-a', 'unrestricted', call('write-template', 'write_file', { path: '.env.production.example', content: 'TOKEN=' }), 'run-a');

  assert.equal(result.ok, true);
  assert.equal(fake.reads(), 2);
  assert.equal(fake.writes(), 1);
});
