import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionPathScopeRuntime, type ExecutionPathScopeSnapshot } from '../src/execution-path-scope';

function snapshot(input: Partial<ExecutionPathScopeSnapshot> = {}): ExecutionPathScopeSnapshot {
  return {
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    projectId: input.projectId ?? 'project-a',
    allowedPaths: input.allowedPaths ?? ['src', 'tests/unit'],
    configuredAt: input.configuredAt ?? 1000,
  };
}

test('sem escopo configurado preserva o comportamento atual', () => {
  const runtime = new ExecutionPathScopeRuntime();
  const result = runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'write_file', paths: ['anywhere.txt'] });
  assert.equal(result.configured, false);
  assert.equal(result.decision, 'allow');
});

test('escopo é imutável e configuração idêntica é idempotente', () => {
  const runtime = new ExecutionPathScopeRuntime(() => 1000);
  const first = runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src', './tests/unit', 'src'] });
  const repeated = runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['tests/unit', 'src'] });
  assert.deepEqual(repeated, first);
  assert.deepEqual(first.allowedPaths, ['src', 'tests/unit']);
  assert.throws(() => runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['docs'] }), /imutável/i);
});

test('permite caminho exato e descendentes e bloqueia irmãos', () => {
  const runtime = new ExecutionPathScopeRuntime();
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src/features'] });
  assert.equal(runtime.allowsPath('chat-a', 'run-a', 'project-a', 'src/features'), true);
  assert.equal(runtime.allowsPath('chat-a', 'run-a', 'project-a', 'src/features/chat/index.ts'), true);
  assert.equal(runtime.allowsPath('chat-a', 'run-a', 'project-a', 'src/feature-other.ts'), false);

  const denied = runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'rename_file', paths: ['src/features/a.ts', 'src/outside.ts'] });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reasons.join(' '), /src\/outside\.ts/);
});

test('raiz ponto representa o workspace inteiro', () => {
  const runtime = new ExecutionPathScopeRuntime();
  const configured = runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src', '.'] });
  assert.deepEqual(configured.allowedPaths, ['.']);
  assert.equal(runtime.allowsPath('chat-a', 'run-a', 'project-a', 'deep/file.ts'), true);
});

test('projeto diferente falha fechado', () => {
  const runtime = new ExecutionPathScopeRuntime();
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src'] });
  const result = runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-b', toolName: 'read_file', paths: ['src/a.ts'] });
  assert.equal(result.decision, 'deny');
  assert.match(result.reasons.join(' '), /outro projeto/i);
});

test('shell exige aprovação quando há allowlist ativa', () => {
  const runtime = new ExecutionPathScopeRuntime();
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src'] });
  const result = runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'run_command' });
  assert.equal(result.decision, 'ask');
  assert.match(result.reasons.join(' '), /shell/i);
});

test('operações Git sem escopo observável são tratadas de forma conservadora', () => {
  const runtime = new ExecutionPathScopeRuntime();
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src'] });

  assert.equal(runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'git_diff' }).decision, 'ask');
  assert.equal(runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'git_stage_all' }).decision, 'deny');
  assert.equal(runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'git_checkout' }).decision, 'deny');
  assert.equal(runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'git_commit' }).decision, 'deny');
});

test('git_stage respeita todos os caminhos informados', () => {
  const runtime = new ExecutionPathScopeRuntime();
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src'] });
  const allowed = runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'git_stage', paths: ['src/a.ts', 'src/b.ts'] });
  const denied = runtime.evaluate({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', toolName: 'git_stage', paths: ['src/a.ts', 'package.json'] });
  assert.equal(allowed.decision, 'allow');
  assert.equal(denied.decision, 'deny');
});

test('restore é atômico, silencioso e usa cópias defensivas', () => {
  const runtime = new ExecutionPathScopeRuntime();
  const events: ExecutionPathScopeSnapshot[][] = [];
  runtime.subscribe((snapshots) => events.push(snapshots));
  runtime.restore([snapshot()]);
  assert.equal(events.length, 0);
  assert.deepEqual(runtime.get('chat-a', 'run-a')?.allowedPaths, ['src', 'tests/unit']);

  const listed = runtime.list();
  listed[0].allowedPaths.push('outside');
  assert.deepEqual(runtime.get('chat-a', 'run-a')?.allowedPaths, ['src', 'tests/unit']);

  assert.throws(() => runtime.restore([snapshot({ runId: 'dup' }), snapshot({ runId: 'dup' })]), /duplicado/i);
  assert.equal(runtime.get('chat-a', 'run-a')?.runId, 'run-a');
});

test('normalização rejeita caminhos absolutos e traversal', () => {
  const runtime = new ExecutionPathScopeRuntime();
  assert.throws(() => runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['../secret'] }), /workspace/i);
  assert.throws(() => runtime.configure({ chatId: 'chat-a', runId: 'run-b', projectId: 'project-a', allowedPaths: ['C:/secret'] }), /relativos/i);
  assert.throws(() => runtime.configure({ chatId: 'chat-a', runId: 'run-c', projectId: 'project-a', allowedPaths: [] }), /pelo menos um/i);
});

test('removeChat isola execuções de outros chats', () => {
  const runtime = new ExecutionPathScopeRuntime();
  runtime.configure({ chatId: 'chat-a', runId: 'run-a', projectId: 'project-a', allowedPaths: ['src'] });
  runtime.configure({ chatId: 'chat-a', runId: 'run-b', projectId: 'project-a', allowedPaths: ['tests'] });
  runtime.configure({ chatId: 'chat-b', runId: 'run-c', projectId: 'project-b', allowedPaths: ['lib'] });
  assert.equal(runtime.removeChat('chat-a'), 2);
  assert.equal(runtime.get('chat-a', 'run-a'), undefined);
  assert.deepEqual(runtime.get('chat-b', 'run-c')?.allowedPaths, ['lib']);
});
