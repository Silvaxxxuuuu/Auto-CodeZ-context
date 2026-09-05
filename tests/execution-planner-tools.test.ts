import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ExecutionPlanner } from '../src/execution-planner';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-planner-tools-'));
  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Planner Tool Test',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const runtime = new ToolRuntime(new WorkspaceRuntime(async () => [project]));
  const planner = new ExecutionPlanner();
  runtime.configureExecutionPlanner(planner);
  return { root, runtime, planner, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('planner tools are exposed and allowed even in read-only because they do not mutate the workspace', async () => {
  const value = await fixture();
  try {
    const names = value.runtime.listDefinitions().map((definition) => definition.name);
    assert.equal(names.includes('plan_execution'), true);
    assert.equal(names.includes('complete_plan_step'), true);

    const result = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('plan-1', 'plan_execution', {
      objective: 'Analisar e validar arquivo',
      steps: ['Ler arquivo', 'Validar resultado'],
    }), 'run-a');

    assert.equal(result.ok, true);
    assert.equal(value.planner.get('chat-a', 'run-a')?.steps[0].status, 'running');
  } finally {
    await value.cleanup();
  }
});

test('complete_plan_step falha sem evidência real', async () => {
  const value = await fixture();
  try {
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('plan-1', 'plan_execution', {
      objective: 'Inspecionar',
      steps: ['Ler arquivo'],
    }), 'run-a');

    const result = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('complete-1', 'complete_plan_step', {}), 'run-a');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /evidência real/i);
    assert.equal(value.planner.get('chat-a', 'run-a')?.steps[0].status, 'running');
  } finally {
    await value.cleanup();
  }
});

test('ferramenta real registra evidência e permite avançar para o próximo passo', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'sample.txt'), 'conteúdo real', 'utf8');
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('plan-1', 'plan_execution', {
      objective: 'Inspecionar e concluir',
      steps: ['Ler arquivo', 'Finalizar'],
    }), 'run-a');

    const read = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('read-1', 'read_file', { path: 'sample.txt' }), 'run-a');
    assert.equal(read.ok, true);

    const afterRead = value.planner.get('chat-a', 'run-a');
    assert.equal(afterRead?.steps[0].evidence.length, 1);
    assert.equal(afterRead?.steps[0].evidence[0].type, 'tool');
    assert.equal(afterRead?.steps[0].evidence[0].reference, 'sample.txt');

    const advance = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('complete-1', 'complete_plan_step', {}), 'run-a');
    assert.equal(advance.ok, true);
    const advanced = value.planner.get('chat-a', 'run-a');
    assert.equal(advanced?.steps[0].status, 'completed');
    assert.equal(advanced?.steps[1].status, 'running');
  } finally {
    await value.cleanup();
  }
});

test('cada passo precisa de sua própria evidência antes de concluir', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'sample.txt'), 'conteúdo real', 'utf8');
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('plan-1', 'plan_execution', {
      objective: 'Executar duas etapas',
      steps: ['Primeira', 'Segunda'],
    }), 'run-a');
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('read-1', 'read_file', { path: 'sample.txt' }), 'run-a');
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('complete-1', 'complete_plan_step', {}), 'run-a');

    const premature = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('complete-2', 'complete_plan_step', {}), 'run-a');
    assert.equal(premature.ok, false);
    assert.match(premature.error || '', /evidência real/i);
  } finally {
    await value.cleanup();
  }
});

test('evidência de alteração de arquivo é classificada como file', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'sample.txt'), 'antes', 'utf8');
    await value.runtime.execute('chat-a', 'project-test', 'safe', call('plan-1', 'plan_execution', {
      objective: 'Editar arquivo',
      steps: ['Modificar conteúdo'],
    }), 'run-a');

    const edit = await value.runtime.execute('chat-a', 'project-test', 'safe', call('replace_text-1', 'replace_text', {
      path: 'sample.txt',
      oldText: 'antes',
      newText: 'depois',
    }), 'run-a');
    assert.equal(edit.ok, true);

    const plan = value.planner.get('chat-a', 'run-a');
    assert.equal(plan?.steps[0].evidence[0].type, 'file');
    assert.equal(plan?.steps[0].evidence[0].reference, 'sample.txt');
  } finally {
    await value.cleanup();
  }
});

test('plano finaliza somente depois que o último passo tem evidência e é concluído', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(path.join(value.root, 'sample.txt'), 'conteúdo', 'utf8');
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('plan-1', 'plan_execution', {
      objective: 'Finalizar plano',
      steps: ['Único passo'],
    }), 'run-a');
    await value.runtime.execute('chat-a', 'project-test', 'read-only', call('read-1', 'read_file', { path: 'sample.txt' }), 'run-a');
    const complete = await value.runtime.execute('chat-a', 'project-test', 'read-only', call('complete-1', 'complete_plan_step', {}), 'run-a');

    assert.equal(complete.ok, true);
    assert.equal(value.planner.get('chat-a', 'run-a')?.status, 'completed');
  } finally {
    await value.cleanup();
  }
});
