import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

async function createToolRuntime(): Promise<{ root: string; runtime: ToolRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-tool-test-'));
  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Tool Test Project',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const workspace = new WorkspaceRuntime(async () => [project]);
  return {
    root,
    runtime: new ToolRuntime(workspace),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('listDefinitions returns independent definition objects', async () => {
  const fixture = await createToolRuntime();
  try {
    const first = fixture.runtime.listDefinitions();
    const second = fixture.runtime.listDefinitions();
    assert.notEqual(first, second);
    assert.notEqual(first[0], second[0]);
    assert.equal(first.some((definition) => definition.name === 'read_file'), true);
    assert.equal(first.some((definition) => definition.name === 'run_command'), true);
  } finally {
    await fixture.cleanup();
  }
});

test('all tool schemas require every declared property for strict provider compatibility', async () => {
  const fixture = await createToolRuntime();
  try {
    for (const definition of fixture.runtime.listDefinitions()) {
      const properties = definition.parameters.properties;
      assert.ok(properties && typeof properties === 'object');
      const propertyNames = Object.keys(properties as Record<string, unknown>);
      const required = Array.isArray(definition.parameters.required) ? definition.parameters.required : [];
      assert.deepEqual([...required].sort(), [...propertyNames].sort(), definition.name);
      assert.equal(definition.parameters.additionalProperties, false, definition.name);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('read_file executes without approval and returns file contents', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'src', 'index.ts'), 'export const value = 42;');
    const result = await fixture.runtime.execute('project-test', 'ask', call('call-1', 'read_file', { path: 'src/index.ts' }));

    assert.equal(result.ok, true);
    assert.equal(result.output, 'export const value = 42;');
    assert.equal(result.pendingApproval, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('write_file creates an approval and does not modify the file before approval', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const result = await fixture.runtime.execute('project-test', 'ask', call('call-2', 'write_file', {
      path: 'notes.txt',
      content: 'after',
    }));

    assert.equal(result.ok, false);
    assert.equal(result.pendingApproval, true);
    assert.ok(result.approvalId);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'before');
    assert.equal(fixture.runtime.listApprovals().length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('approving a write_file executes it and consumes the approval', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const pending = await fixture.runtime.execute('project-test', 'ask', call('call-3', 'write_file', {
      path: 'notes.txt',
      content: 'after',
    }));
    assert.ok(pending.approvalId);

    const result = await fixture.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'after');
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('approving the same approval twice fails without executing twice', async () => {
  const fixture = await createToolRuntime();
  try {
    await fs.writeFile(path.join(fixture.root, 'notes.txt'), 'before');
    const pending = await fixture.runtime.execute('project-test', 'ask', call('call-4', 'write_file', {
      path: 'notes.txt',
      content: 'after',
    }));
    assert.ok(pending.approvalId);

    await fixture.runtime.approve(pending.approvalId!);
    await assert.rejects(fixture.runtime.approve(pending.approvalId!), /Aprovação não encontrada/);
    assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'after');
  } finally {
    await fixture.cleanup();
  }
});

test('invalid tool input is rejected before permission or execution', async () => {
  const fixture = await createToolRuntime();
  try {
    const result = await fixture.runtime.execute('project-test', 'unrestricted', call('call-5', 'read_file', {
      path: 'src/index.ts',
      unexpected: true,
    }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Parâmetro não permitido/);
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('read-only permission denies write tools', async () => {
  const fixture = await createToolRuntime();
  try {
    const result = await fixture.runtime.execute('project-test', 'read-only', call('call-6', 'write_file', {
      path: 'notes.txt',
      content: 'blocked',
    }));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /bloqueada pelas permissões/);
    assert.equal(fixture.runtime.listApprovals().length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('run_command fails closed when no command runtime is configured', async () => {
  const fixture = await createToolRuntime();
  try {
    const pending = await fixture.runtime.execute('project-test', 'ask', call('call-7', 'run_command', {
      manager: 'npm',
      script: 'test',
    }));
    assert.equal(pending.pendingApproval, true);
    assert.ok(pending.approvalId);

    const result = await fixture.runtime.approve(pending.approvalId!);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /runtime de comandos não foi configurado/i);
  } finally {
    await fixture.cleanup();
  }
});
