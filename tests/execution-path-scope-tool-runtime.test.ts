import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { CommandRuntime } from '../src/agent/command-runtime';
import { ExecutionPathScopeRuntime } from '../src/execution-path-scope';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-scoped-tools-'));
  const project: ProjectRecord = { id: 'project-a', name: 'Scoped Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const projects = async () => [project];
  const workspace = new WorkspaceRuntime(projects);
  const runtime = new ToolRuntime(workspace, undefined, undefined, undefined, new CommandRuntime(projects));
  const scopes = new ExecutionPathScopeRuntime(() => 1000);
  runtime.configureExecutionPathScope(scopes);
  return { root, workspace, runtime, scopes, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('ToolRuntime permite leitura dentro do escopo e bloqueia leitura fora dele', async () => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'src', 'inside.ts'), 'inside');
    await fs.writeFile(path.join(fixture.root, 'outside.ts'), 'outside');
    await fixture.runtime.configureExecutionAllowedPaths('chat-a', 'run-a', 'project-a', ['src']);

    const allowed = await fixture.runtime.execute('chat-a', 'project-a', 'unrestricted', call('inside', 'read_file', { path: 'src/inside.ts' }), 'run-a');
    const denied = await fixture.runtime.execute('chat-a', 'project-a', 'unrestricted', call('outside', 'read_file', { path: 'outside.ts' }), 'run-a');

    assert.equal(allowed.ok, true);
    assert.equal(allowed.output, 'inside');
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? '', /fora do escopo permitido/i);
  } finally {
    await fixture.cleanup();
  }
});

test('search_files filtra resultados fora do escopo ativo', async () => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
    await fs.mkdir(path.join(fixture.root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'src', 'shared-inside.ts'), 'inside');
    await fs.writeFile(path.join(fixture.root, 'docs', 'shared-outside.ts'), 'outside');
    await fixture.runtime.configureExecutionAllowedPaths('chat-a', 'run-a', 'project-a', ['src']);

    const result = await fixture.runtime.execute('chat-a', 'project-a', 'unrestricted', call('search', 'search_files', { query: 'shared' }), 'run-a');
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output ?? '[]'), ['src/shared-inside.ts']);
  } finally {
    await fixture.cleanup();
  }
});

test('run_command exige aprovação com allowlist ativa mesmo em unrestricted', async () => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
    await fixture.runtime.configureExecutionAllowedPaths('chat-a', 'run-a', 'project-a', ['src']);
    const result = await fixture.runtime.execute('chat-a', 'project-a', 'unrestricted', call('command', 'run_command', { command: 'node -v' }), 'run-a');
    assert.equal(result.ok, false);
    assert.equal(result.pendingApproval, true);
    assert.ok(result.approvalId);
  } finally {
    await fixture.cleanup();
  }
});

test('aprovação pendente é revalidada contra escopo configurado depois do preview', async () => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'outside.txt'), 'before');
    const pending = await fixture.runtime.execute('chat-a', 'project-a', 'ask', call('write', 'write_file', { path: 'outside.txt', content: 'after' }), 'run-a');
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);

    await fixture.runtime.configureExecutionAllowedPaths('chat-a', 'run-a', 'project-a', ['src']);
    const approved = await fixture.runtime.approve(pending.approvalId!);
    assert.equal(approved.ok, false);
    assert.match(approved.error ?? '', /fora do escopo permitido/i);
    assert.equal(await fs.readFile(path.join(fixture.root, 'outside.txt'), 'utf8'), 'before');
  } finally {
    await fixture.cleanup();
  }
});

test('canonicalização impede bypass da allowlist por link de diretório', async (t) => {
  const fixture = await createFixture();
  try {
    await fs.mkdir(path.join(fixture.root, 'allowed'), { recursive: true });
    await fs.mkdir(path.join(fixture.root, 'secret'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'secret', 'value.txt'), 'secret');
    const link = path.join(fixture.root, 'allowed', 'link');
    try {
      await fs.symlink(path.join(fixture.root, 'secret'), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip(`Links não suportados neste runner: ${code}`);
        return;
      }
      throw error;
    }

    await fixture.runtime.configureExecutionAllowedPaths('chat-a', 'run-a', 'project-a', ['allowed']);
    const result = await fixture.runtime.execute('chat-a', 'project-a', 'unrestricted', call('linked', 'read_file', { path: 'allowed/link/value.txt' }), 'run-a');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /fora do escopo permitido/i);
    assert.equal(await fixture.workspace.canonicalRelativePath('project-a', 'allowed/link/value.txt'), 'secret/value.txt');
  } finally {
    await fixture.cleanup();
  }
});
