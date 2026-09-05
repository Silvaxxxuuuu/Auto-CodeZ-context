import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionChangeBudgetRuntime } from '../src/execution-change-budget';
import type { DiffPlan, FileDiff } from '../src/ai/types';

function change(path: string, addedLines: number, removedLines: number, renamedFrom?: string): FileDiff {
  return {
    path,
    type: renamedFrom ? 'renamed' : 'modified',
    before: '',
    after: '',
    addedLines,
    removedLines,
    ...(renamedFrom ? { renamedFrom } : {}),
  };
}

function plan(changes: FileDiff[]): DiffPlan {
  return {
    id: 'plan-a',
    createdAt: 1000,
    changes,
    summary: {
      files: changes.length,
      created: 0,
      modified: changes.filter((item) => item.type === 'modified').length,
      deleted: 0,
      renamed: changes.filter((item) => item.type === 'renamed').length,
      addedLines: changes.reduce((total, item) => total + item.addedLines, 0),
      removedLines: changes.reduce((total, item) => total + item.removedLines, 0),
    },
  };
}

test('sem budget configurado preserva o comportamento atual', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  const evaluation = runtime.evaluate('chat-a', 'run-a', {
    toolName: 'write_file',
    diffPlan: plan([change('src/a.ts', 200, 100)]),
  });

  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.budget, undefined);
});

test('budget é imutável por execução e repetição idêntica é idempotente', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  const first = runtime.configure('chat-a', 'run-a', { maxFiles: 3, maxChangedLines: 40, maxCommands: 2, maxToolCalls: 6 });
  const repeated = runtime.configure('chat-a', 'run-a', { maxFiles: 3, maxChangedLines: 40, maxCommands: 2, maxToolCalls: 6 });

  assert.deepEqual(repeated, first);
  assert.throws(() => runtime.configure('chat-a', 'run-a', { maxFiles: 4 }), /imutável/i);
});

test('bloqueia alteração antes de ultrapassar arquivos ou linhas', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  runtime.configure('chat-a', 'run-a', { maxFiles: 1, maxChangedLines: 5 });

  const evaluation = runtime.evaluate('chat-a', 'run-a', {
    toolName: 'replace_text',
    diffPlan: plan([change('src/a.ts', 4, 2)]),
  });

  assert.equal(evaluation.allowed, false);
  assert.match(evaluation.violations.join(' '), /Linhas alteradas: 6\/5/);
});

test('arquivos já tocados não contam novamente no limite de arquivos', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  runtime.configure('chat-a', 'run-a', { maxFiles: 1, maxChangedLines: 20 });
  runtime.record('chat-a', 'run-a', { toolName: 'replace_text', changes: [change('src/a.ts', 2, 1)] });

  const evaluation = runtime.evaluate('chat-a', 'run-a', {
    toolName: 'replace_range',
    diffPlan: plan([change('src/a.ts', 3, 2)]),
  });

  assert.equal(evaluation.allowed, true);
  assert.deepEqual(evaluation.projected.files, ['src/a.ts']);
  assert.equal(evaluation.projected.changedLines, 8);
});

test('renomeação contabiliza origem e destino como caminhos envolvidos', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  runtime.configure('chat-a', 'run-a', { maxFiles: 1 });

  const evaluation = runtime.evaluate('chat-a', 'run-a', {
    toolName: 'rename_file',
    diffPlan: plan([change('src/new.ts', 0, 0, 'src/old.ts')]),
  });

  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.projected.files.length, 2);
});

test('comandos e ferramentas usam contadores independentes', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  runtime.configure('chat-a', 'run-a', { maxCommands: 1, maxToolCalls: 2 });

  runtime.record('chat-a', 'run-a', { toolName: 'read_file' });
  runtime.record('chat-a', 'run-a', { toolName: 'run_command' });

  const nextCommand = runtime.evaluate('chat-a', 'run-a', { toolName: 'run_command' });
  assert.equal(nextCommand.allowed, false);
  assert.match(nextCommand.violations.join(' '), /Comandos: 2\/1/);
  assert.match(nextCommand.violations.join(' '), /Ferramentas: 3\/2/);
});

test('controles de plano não consomem orçamento de tool calls', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  runtime.configure('chat-a', 'run-a', { maxToolCalls: 1 });

  runtime.record('chat-a', 'run-a', { toolName: 'plan_execution' });
  runtime.record('chat-a', 'run-a', { toolName: 'complete_plan_step' });

  assert.equal(runtime.getUsage('chat-a', 'run-a').toolCalls, 0);
  assert.equal(runtime.evaluate('chat-a', 'run-a', { toolName: 'read_file' }).allowed, true);
});

test('limites inválidos são rejeitados e removeChat isola execuções', () => {
  const runtime = new ExecutionChangeBudgetRuntime();
  assert.throws(() => runtime.configure('chat-a', 'run-a', { maxFiles: -1 }), /inteiro não negativo/i);

  runtime.configure('chat-a', 'run-a', { maxFiles: 1 });
  runtime.configure('chat-a', 'run-b', { maxFiles: 2 });
  runtime.configure('chat-b', 'run-c', { maxFiles: 3 });

  assert.equal(runtime.removeChat('chat-a'), 2);
  assert.equal(runtime.getBudget('chat-a', 'run-a'), undefined);
  assert.deepEqual(runtime.getBudget('chat-b', 'run-c'), { maxFiles: 3, maxChangedLines: undefined, maxCommands: undefined, maxToolCalls: undefined });
});
