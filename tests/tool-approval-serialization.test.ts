import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { CommandRuntime } from '../src/agent/command-runtime';
import { SYSTEM_WORKSPACE_ID } from '../src/agent/system-workspace';
import type { ProjectRecord } from '../src/ai/types';

test('only the first approval-dependent tool call is materialized in a cycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-approval-serialization-'));
  try {
    const project: ProjectRecord = { id: 'project-test', name: 'Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
    const workspace = new WorkspaceRuntime(async () => [project]);
    const runtime = new ToolRuntime(workspace, undefined, undefined, undefined, new CommandRuntime(async () => [project]));

    const first = await runtime.execute('chat-test', 'project-test', 'ask', { id: 'call-1', name: 'run_command', input: { command: 'mkdir first' } }, 'run-test');
    const second = await runtime.execute('chat-test', 'project-test', 'ask', { id: 'call-2', name: 'run_command', input: { command: 'mkdir second' } }, 'run-test');

    assert.equal(first.pendingApproval, true);
    assert.ok(first.approvalId);
    assert.equal(second.pendingApproval, undefined);
    assert.equal(second.ok, false);
    assert.match(second.error ?? '', /operação anterior.*aguarda aprovação/i);
    assert.equal(runtime.listApprovals({ chatId: 'chat-test', runId: 'run-test' }).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a different chat is not blocked by another chats approval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-approval-isolation-'));
  try {
    const project: ProjectRecord = { id: 'project-test', name: 'Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
    const workspace = new WorkspaceRuntime(async () => [project]);
    const runtime = new ToolRuntime(workspace, undefined, undefined, undefined, new CommandRuntime(async () => [project]));

    const first = await runtime.execute('chat-a', 'project-test', 'ask', { id: 'call-a', name: 'run_command', input: { command: 'mkdir first' } }, 'run-a');
    const second = await runtime.execute('chat-b', 'project-test', 'ask', { id: 'call-b', name: 'run_command', input: { command: 'mkdir second' } }, 'run-b');

    assert.equal(first.pendingApproval, true);
    assert.equal(second.pendingApproval, true);
    assert.equal(runtime.listApprovals().length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('safe mode requires approval before creating a file in the protected system workspace', async () => {
  const workspace = new WorkspaceRuntime(async () => []);
  const runtime = new ToolRuntime(workspace);
  const relativePath = `.auto-codez-safe-test-${process.pid}-${Date.now()}.txt`;

  const result = await runtime.execute(
    'chat-system-safe',
    SYSTEM_WORKSPACE_ID,
    'safe',
    { id: 'system-create', name: 'create_file', input: { path: relativePath, content: 'private data' } },
    'run-system-safe',
  );

  assert.equal(result.pendingApproval, true);
  assert.ok(result.diffPlan?.changes.length);
  assert.equal(await workspace.exists(SYSTEM_WORKSPACE_ID, relativePath), false);
});

test('unrestricted mode remains explicit for protected system workspace writes', async () => {
  const workspace = new WorkspaceRuntime(async () => []);
  const runtime = new ToolRuntime(workspace);
  const relativePath = `.auto-codez-unrestricted-test-${process.pid}-${Date.now()}.txt`;
  try {
    const result = await runtime.execute(
      'chat-system-unrestricted',
      SYSTEM_WORKSPACE_ID,
      'unrestricted',
      { id: 'system-create-unrestricted', name: 'create_file', input: { path: relativePath, content: 'allowed' } },
      'run-system-unrestricted',
    );

    assert.equal(result.ok, true);
    assert.equal(result.pendingApproval, undefined);
    assert.equal(await workspace.readFile(SYSTEM_WORKSPACE_ID, relativePath), 'allowed');
  } finally {
    if (await workspace.exists(SYSTEM_WORKSPACE_ID, relativePath)) await workspace.deleteFile(SYSTEM_WORKSPACE_ID, relativePath);
  }
});
