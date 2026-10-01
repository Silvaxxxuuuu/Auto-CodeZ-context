import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIToolCall } from '../src/ai/types';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';
import { ShadowAwareToolRuntime } from '../src/agent/shadow-aware-tool-runtime';
import { ShadowAwareWorkspaceRuntime } from '../src/agent/shadow-aware-workspace-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { InstanceRuntime } from '../src/agent/instance-runtime';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { ApprovalRuntime } from '../src/agent/approval-runtime';
import { PermissionRuntime } from '../src/agent/permission-runtime';
import { ProcessRuntime } from '../src/agent/process-runtime';
import { ShadowAwareCommandRuntime } from '../src/agent/shadow-aware-command-runtime';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-aware-tools-'));
  await writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
  const base = new WorkspaceRuntime(async () => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }]);
  let time = 100;
  const shadows = new ExecutionShadowWorkspaceRuntime(base, () => time++);
  const workspace = new ShadowAwareWorkspaceRuntime(base, shadows);
  const tools = new ShadowAwareToolRuntime(workspace);
  const openedInstances: string[] = [];
  tools.configureShadowWorkspace(shadows);
  tools.configureInstanceRuntime(new InstanceRuntime({
    open: async (input) => {
      openedInstances.push(input.instanceId);
      return { canFocus: false, canClose: false };
    },
  }));
  return {
    base,
    shadows,
    tools,
    openedInstances,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

function toolCall(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('mutação irrestrita fica no shadow e leitura da mesma run enxerga o overlay', async () => {
  const fx = await fixture();
  try {
    const write = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('write-a', 'write_file', { path: 'a.txt', content: 'shadow' }),
      'run-a',
    );
    assert.equal(write.ok, true);
    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'base');
    assert.equal(fx.shadows.get('chat-a', 'run-a')?.changes.length, 1);

    const read = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('read-a', 'read_file', { path: 'a.txt' }),
      'run-a',
    );
    assert.equal(read.ok, true);
    assert.equal(read.output, 'shadow');
  } finally {
    await fx.cleanup();
  }
});

test('outra run continua vendo a base enquanto o primeiro shadow está ativo', async () => {
  const fx = await fixture();
  try {
    await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('write-a', 'write_file', { path: 'a.txt', content: 'shadow-a' }),
      'run-a',
    );

    const other = await fx.tools.execute(
      'chat-b',
      'project-a',
      'unrestricted',
      toolCall('read-b', 'read_file', { path: 'a.txt' }),
      'run-b',
    );

    assert.equal(other.ok, true);
    assert.equal(other.output, 'base');
    assert.equal(fx.shadows.get('chat-b', 'run-b'), undefined);
  } finally {
    await fx.cleanup();
  }
});

test('aprovação é executada dentro do shadow pertencente ao approval', async () => {
  const fx = await fixture();
  try {
    const pending = await fx.tools.execute(
      'chat-a',
      'project-a',
      'ask',
      toolCall('write-approved', 'write_file', { path: 'a.txt', content: 'approved-shadow' }),
      'run-a',
    );

    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);
    assert.equal(fx.shadows.get('chat-a', 'run-a'), undefined);

    const approved = await fx.tools.approve(pending.approvalId as string);

    assert.equal(approved.ok, true);
    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'base');
    assert.equal(fx.shadows.get('chat-a', 'run-a')?.changes[0].after, 'approved-shadow');
  } finally {
    await fx.cleanup();
  }
});

test('create delete rename e search usam o mesmo overlay da execução', async () => {
  const fx = await fixture();
  try {
    const create = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('create-b', 'create_file', { path: 'new-item.txt', content: 'new' }),
      'run-a',
    );
    const rename = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('rename-b', 'rename_file', { from: 'new-item.txt', to: 'renamed-item.txt' }),
      'run-a',
    );
    const search = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('search-b', 'search_files', { query: 'item' }),
      'run-a',
    );

    assert.equal(create.ok, true);
    assert.equal(rename.ok, true);
    assert.equal(search.ok, true);
    assert.deepEqual(JSON.parse(search.output ?? '[]'), ['renamed-item.txt']);
    assert.equal(await fx.base.exists('project-a', 'new-item.txt'), false);
    assert.equal(await fx.base.exists('project-a', 'renamed-item.txt'), false);
  } finally {
    await fx.cleanup();
  }
});

test('mutação Git falha fechado depois que a run possui alterações isoladas', async () => {
  const fx = await fixture();
  try {
    const write = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('write-shadow', 'write_file', { path: 'a.txt', content: 'shadow' }),
      'run-a',
    );
    assert.equal(write.ok, true);

    const git = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('git-after-shadow', 'git_stage_all', {}),
      'run-a',
    );

    assert.equal(git.ok, false);
    assert.match(git.error ?? '', /Git mutável bloqueada/i);
    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'base');
  } finally {
    await fx.cleanup();
  }
});

test('tool call sem runId mantém comportamento direto na base', async () => {
  const fx = await fixture();
  try {
    const result = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('write-direct', 'write_file', { path: 'a.txt', content: 'direct' }),
    );

    assert.equal(result.ok, true);
    assert.equal(await fx.base.readFile('project-a', 'a.txt'), 'direct');
    assert.equal(fx.shadows.list().length, 0);
  } finally {
    await fx.cleanup();
  }
});


test('open_instance ligado ao workspace falha fechado enquanto Shadow legado está ativo', async () => {
  const fx = await fixture();
  try {
    const write = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('write-shadow-instance', 'write_file', { path: 'a.txt', content: 'shadow' }),
      'run-a',
    );
    assert.equal(write.ok, true);

    const opened = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('open-shadow-file', 'open_instance', { kind: 'file', target: 'a.txt' }),
      'run-a',
    );

    assert.equal(opened.ok, false);
    assert.match(opened.error ?? '', /Shadow Workspace legado|visão divergente/i);

    const captured = await fx.tools.execute(
      'chat-a',
      'project-a',
      'unrestricted',
      toolCall('capture-shadow-preview', 'capture_instance', { instanceId: 'existing-preview' }),
      'run-a',
    );
    assert.equal(captured.ok, false);
    assert.match(captured.error ?? '', /Shadow Workspace legado|visão divergente/i);

    const inspected = await fx.tools.execute('chat-a', 'project-a', 'read-only',
      toolCall('inspect-shadow-preview', 'inspect_instance', { instanceId: 'existing-preview' }), 'run-a');
    assert.equal(inspected.ok, false);
    assert.match(inspected.error ?? '', /Shadow Workspace legado|visão divergente/i);
    const interacted = await fx.tools.execute('chat-a', 'project-a', 'unrestricted',
      toolCall('click-shadow-preview', 'interact_instance', { instanceId: 'existing-preview', action: 'click_button', selector: '#refresh' }), 'run-a');
    assert.equal(interacted.ok, false);
    assert.match(interacted.error ?? '', /Shadow Workspace legado|visão divergente/i);
    assert.deepEqual(fx.openedInstances, []);
  } finally {
    await fx.cleanup();
  }
});


test('run_command V2 keeps sandbox isolation without creating shadow that blocks start_process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-command-process-v2-'));
  const projects = async () => [{
    id: 'project-a',
    name: 'Project A',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  }];
  const base = new WorkspaceRuntime(projects);
  const shadows = new ExecutionShadowWorkspaceRuntime(base);
  const workspace = new ShadowAwareWorkspaceRuntime(base, shadows);
  const approvals = new ApprovalRuntime();
  const commandRuntime = new ShadowAwareCommandRuntime(projects, shadows);
  const processRuntime = new ProcessRuntime(projects);
  const tools = new ShadowAwareToolRuntime(
    workspace,
    new PermissionRuntime(),
    new ActivityRuntime(),
    approvals,
    commandRuntime,
  );
  tools.configureShadowWorkspace(shadows);
  tools.configureProcessRuntime(processRuntime);

  const executeApproved = async (call: AIToolCall) => {
    const initial = await tools.execute('chat-a', 'project-a', 'unrestricted', call, 'run-v2');
    if (!initial.pendingApproval || !initial.approvalId) return initial;
    return tools.approve(initial.approvalId);
  };

  try {
    const command = await executeApproved(toolCall(
      'command-1',
      'run_command',
      { command: 'node -e "process.stdout.write(\'sandbox-ok\')"' },
    ));
    assert.equal(command.ok, true, command.error);
    assert.match(command.commandResult?.stdout ?? command.output ?? '', /sandbox-ok/);
    assert.equal(shadows.get('chat-a', 'run-v2'), undefined);

    const started = await executeApproved(toolCall(
      'process-1',
      'start_process',
      { command: 'node -e "setInterval(()=>{},1000)"' },
    ));
    assert.equal(started.ok, true, started.error);
    assert.ok(started.processId);
    assert.equal(started.executionId, 'process:run-v2:process-1');
    assert.equal(shadows.get('chat-a', 'run-v2'), undefined);
    assert.equal(processRuntime.get('project-a', started.processId as string)?.status, 'running');
  } finally {
    await processRuntime.stopAll().catch((): never[] => []);
    await rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 50 : 0, retryDelay: 100 });
  }
});
