import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';
import { ShadowAwareCommandRuntime } from '../src/agent/shadow-aware-command-runtime';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { ShadowAwareWorkspaceRuntime } from '../src/agent/shadow-aware-workspace-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-command-integration-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
  const projects = async (): Promise<ProjectRecord[]> => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }];
  const base = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(base);
  const workspace = new ShadowAwareWorkspaceRuntime(base, shadows);
  const commands = new ShadowAwareCommandRuntime(projects, shadows);
  const tools = new ShadowAwareToolRuntime(workspace, undefined, undefined, undefined, commands);
  tools.configureShadowWorkspace(shadows);
  return {
    root,
    base,
    shadows,
    tools,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

const readCommand = 'node -e "console.log(require(\'fs\').readFileSync(\'a.txt\',\'utf8\'))"';

test('run_command em unrestricted valida o conteúdo do shadow sem publicar a alteração', async () => {
  const fx = await fixture();
  try {
    const write = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('write-shadow', 'write_file', { path: 'a.txt', content: 'shadow-value' }),
      'run-a',
    );
    assert.equal(write.ok, true);

    const command = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('validate-shadow', 'run_command', { command: readCommand }),
      'run-a',
    );

    assert.equal(command.ok, true);
    assert.match(command.output ?? '', /shadow-value/);
    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'base');
    assert.equal(fx.shadows.get('chat-a', 'run-a')?.changes[0].after, 'shadow-value');
  } finally {
    await fx.cleanup();
  }
});

test('run_command aprovado retoma no mesmo shadow e só executa depois da aprovação', async () => {
  const fx = await fixture();
  try {
    await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('write-shadow', 'write_file', { path: 'a.txt', content: 'approved-shadow' }),
      'run-a',
    );

    const pending = await fx.tools.execute(
      'chat-a',
      'project-a',
      'ask',
      call('validate-approved-shadow', 'run_command', { command: readCommand }),
      'run-a',
    );

    assert.equal(pending.ok, false);
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);

    const approved = await fx.tools.approve(pending.approvalId as string);

    assert.equal(approved.ok, true);
    assert.match(approved.output ?? '', /approved-shadow/);
    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'base');
  } finally {
    await fx.cleanup();
  }
});

test('Git continua bloqueado enquanto o command sandbox está disponível', async () => {
  const fx = await fixture();
  try {
    await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('write-shadow', 'write_file', { path: 'a.txt', content: 'shadow' }),
      'run-a',
    );

    const git = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      call('git-shadow', 'git_status', {}),
      'run-a',
    );

    assert.equal(git.ok, false);
    assert.match(git.error ?? '', /Git bloqueada/i);
  } finally {
    await fx.cleanup();
  }
});
