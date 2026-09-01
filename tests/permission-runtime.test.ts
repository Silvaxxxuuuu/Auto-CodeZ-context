import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionRuntime } from '../src/agent/permission-runtime';

test('read tools are always allowed', () => {
  const runtime = new PermissionRuntime();
  for (const level of ['read-only', 'safe', 'ask', 'unrestricted'] as const) {
    assert.equal(runtime.decide(level, 'read_file'), 'allow');
    assert.equal(runtime.decide(level, 'search_files'), 'allow');
  }
});

test('read-only denies every write tool', () => {
  const runtime = new PermissionRuntime();
  for (const tool of ['write_file', 'create_file', 'delete_file', 'rename_file', 'run_command'] as const) {
    assert.equal(runtime.decide('read-only', tool), 'deny');
  }
});

test('safe writes are allowed, sensitive writes require approval', () => {
  const runtime = new PermissionRuntime();
  assert.equal(runtime.decide('safe', 'write_file'), 'allow');
  assert.equal(runtime.decide('safe', 'create_file'), 'allow');
  assert.equal(runtime.decide('safe', 'delete_file'), 'ask');
  assert.equal(runtime.decide('safe', 'rename_file'), 'ask');
  assert.equal(runtime.decide('safe', 'run_command'), 'ask');
});

test('ask requires approval for all writes', () => {
  const runtime = new PermissionRuntime();
  for (const tool of ['write_file', 'create_file', 'delete_file', 'rename_file', 'run_command'] as const) {
    assert.equal(runtime.decide('ask', tool), 'ask');
  }
});

test('unrestricted is the only level that automatically allows sensitive writes', () => {
  const runtime = new PermissionRuntime();
  for (const tool of ['delete_file', 'rename_file', 'run_command'] as const) {
    assert.equal(runtime.decide('unrestricted', tool), 'allow');
  }
});

test('unknown tools are denied and are not treated as writes', () => {
  const runtime = new PermissionRuntime();
  assert.equal(runtime.decide('unrestricted', 'unknown_tool' as never), 'deny');
  assert.equal(runtime.isWriteTool('unknown_tool' as never), false);
});

test('isWriteTool matches the permission write policy', () => {
  const runtime = new PermissionRuntime();
  assert.equal(runtime.isWriteTool('read_file'), false);
  assert.equal(runtime.isWriteTool('search_files'), false);
  for (const tool of ['write_file', 'create_file', 'delete_file', 'rename_file', 'run_command'] as const) {
    assert.equal(runtime.isWriteTool(tool), true);
  }
});
