import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionCoordinator } from '../src/execution-coordinator';
import { ExecutionShadowLifecycle } from '../src/execution-shadow-lifecycle';
import type { ExecutionShadowWorkspaceController } from '../src/execution-shadow-workspace-controller';

function fixture(options: { preflightAllowed?: boolean; recoverable?: boolean; commitError?: Error } = {}) {
  const events: string[] = [];
  const completion = {
    execution: {
      chatId: 'chat-a',
      runId: 'run-a',
      state: 'completed' as const,
      startedAt: 1,
      updatedAt: 2,
    },
  };
  const coordinator = {
    completionPreflight: () => {
      events.push('preflight');
      return options.preflightAllowed === false
        ? { allowed: false, error: 'incomplete' }
        : { allowed: true };
    },
    complete: () => {
      events.push('complete');
      return completion;
    },
    fail: (_chatId: string, _runId: string, error: string) => {
      events.push(`fail:${error}`);
      return {
        execution: { ...completion.execution, state: 'failed' as const, error },
        error,
      };
    },
    interrupt: () => {
      events.push('interrupt');
      return { ...completion.execution, state: 'interrupted' as const };
    },
  } as unknown as ExecutionCoordinator;
  const shadows = {
    commitIfPresent: async () => {
      events.push('commit');
      if (options.commitError) throw options.commitError;
      return { committed: true, publicationChanges: [] };
    },
    discardIfPresent: () => {
      events.push('discard');
      return undefined;
    },
    removeChat: () => {
      events.push('remove-chat');
      return 1;
    },
  } as unknown as ExecutionShadowWorkspaceController;
  const lifecycle = new ExecutionShadowLifecycle(
    coordinator,
    shadows,
    () => options.recoverable === true,
  );
  return { lifecycle, events };
}

test('conclusão elegível publica o shadow antes de marcar a execução como concluída', async () => {
  const fx = fixture();

  const result = await fx.lifecycle.complete('chat-a', 'run-a');

  assert.equal(result.completion.execution.state, 'completed');
  assert.equal(result.publication?.committed, true);
  assert.deepEqual(fx.events, ['preflight', 'commit', 'complete']);
});

test('preflight inválido descarta o shadow antes da falha terminal do coordinator', async () => {
  const fx = fixture({ preflightAllowed: false });

  await fx.lifecycle.complete('chat-a', 'run-a');

  assert.deepEqual(fx.events, ['preflight', 'discard', 'complete']);
});

test('falha de publicação descarta o shadow, falha a execução e propaga o erro', async () => {
  const fx = fixture({ commitError: new Error('stale workspace') });

  await assert.rejects(
    () => fx.lifecycle.complete('chat-a', 'run-a'),
    /stale workspace/i,
  );

  assert.deepEqual(fx.events, ['preflight', 'commit', 'discard', 'fail:stale workspace']);
});

test('falha recuperável preserva o shadow para retomada da mesma run', () => {
  const fx = fixture({ recoverable: true });

  fx.lifecycle.fail('chat-a', 'run-a', 'provider failed');

  assert.deepEqual(fx.events, ['fail:provider failed']);
});

test('falha terminal descarta o shadow', () => {
  const fx = fixture({ recoverable: false });

  fx.lifecycle.fail('chat-a', 'run-a', 'terminal failure');

  assert.deepEqual(fx.events, ['fail:terminal failure', 'discard']);
});

test('interrupção e limpeza de chat removem estado isolado antes de encerrar lifecycle', () => {
  const fx = fixture();

  fx.lifecycle.interrupt('chat-a', 'run-a');
  fx.lifecycle.clearChat('chat-a');

  assert.deepEqual(fx.events, ['discard', 'interrupt', 'remove-chat']);
});
