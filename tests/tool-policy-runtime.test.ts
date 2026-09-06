import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIToolCall } from '../src/ai/types';
import { SYSTEM_WORKSPACE_ID } from '../src/agent/system-workspace';
import { ToolPolicyRuntime } from '../src/agent/tool-policy-runtime';

function call(name: AIToolCall['name'], input: Record<string, unknown> = {}): AIToolCall {
  return { id: `call-${name}`, name, input };
}

const runtime = new ToolPolicyRuntime();

test('normal read remains allowed in unrestricted mode', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: 'project-a',
    call: call('read_file', { path: 'src/index.ts' }),
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.blockedBy, null);
  assert.equal(result.classification, 'normal');
  assert.deepEqual(result.paths, ['src/index.ts']);
  assert.deepEqual(result.sources, {
    permission: 'allow',
    path: 'allow',
    command: 'allow',
    systemWorkspace: 'allow',
  });
});

test('sensitive read requires approval even in unrestricted mode', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: 'project-a',
    call: call('read_file', { path: '.env.production' }),
  });

  assert.equal(result.decision, 'ask');
  assert.equal(result.blockedBy, null);
  assert.equal(result.classification, 'sensitive');
  assert.match(result.reasons.join(' '), /variáveis de ambiente/i);
});

test('sensitive mutation is denied by security before permission level can allow it', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: 'project-a',
    call: call('write_file', { path: '.env', content: 'TOKEN=x' }),
  });

  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedBy, 'security');
  assert.equal(result.sources.permission, 'allow');
  assert.equal(result.sources.path, 'deny');
});

test('read-only write denial remains a permission denial', () => {
  const result = runtime.evaluate({
    permissionLevel: 'read-only',
    projectId: 'project-a',
    call: call('write_file', { path: 'notes.txt', content: 'x' }),
  });

  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedBy, 'permission');
  assert.equal(result.sources.permission, 'deny');
  assert.equal(result.sources.path, 'allow');
});

test('system workspace file access requires approval outside unrestricted mode', () => {
  const result = runtime.evaluate({
    permissionLevel: 'safe',
    projectId: SYSTEM_WORKSPACE_ID,
    call: call('read_file', { path: 'README.md' }),
  });

  assert.equal(result.decision, 'ask');
  assert.equal(result.sources.systemWorkspace, 'ask');
  assert.match(result.reasons.join(' '), /workspace interno/i);
});

test('unrestricted system workspace read preserves explicit unrestricted behavior', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: SYSTEM_WORKSPACE_ID,
    call: call('read_file', { path: 'README.md' }),
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.sources.systemWorkspace, 'allow');
});

test('direct Git mutation through the shell still requires approval in unrestricted mode', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: 'project-a',
    call: call('run_command', { command: 'git reset --hard HEAD' }),
  });

  assert.equal(result.decision, 'ask');
  assert.equal(result.sources.command, 'ask');
  assert.match(result.reasons.join(' '), /mutação Git direta/i);
});

test('shell mutation targeting a sensitive file is denied', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: 'project-a',
    call: call('run_command', { command: 'echo TOKEN=x > .env' }),
  });

  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedBy, 'security');
  assert.equal(result.sources.command, 'deny');
  assert.match(result.reasons.join(' '), /variáveis de ambiente/i);
});

test('rename evaluates both source and destination paths', () => {
  const result = runtime.evaluate({
    permissionLevel: 'unrestricted',
    projectId: 'project-a',
    call: call('rename_file', { from: 'src/config.ts', to: '.env' }),
  });

  assert.deepEqual(result.paths, ['src/config.ts', '.env']);
  assert.equal(result.decision, 'deny');
  assert.equal(result.blockedBy, 'security');
});
