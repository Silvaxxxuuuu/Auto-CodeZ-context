import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionManager } from '../src/execution-manager';
import { ExecutionPlanHistory } from '../src/execution-plan-history';
import { ExecutionPlanner } from '../src/execution-planner';
import { ExecutionReportBuilder } from '../src/execution-report';
import { ExecutionTimeline } from '../src/execution-timeline';

function setup() {
  let now = 1000;
  let id = 0;
  const executions = new ExecutionManager();
  const timeline = new ExecutionTimeline(100, () => ++now);
  const planner = new ExecutionPlanner({ now: () => ++now, createId: () => `id-${++id}` });
  const history = new ExecutionPlanHistory(100, () => ++now);
  executions.subscribe((change) => timeline.record(change));
  planner.subscribe((change) => history.record(change));
  return { executions, timeline, planner, history, reports: new ExecutionReportBuilder(executions, timeline, history), tick: () => ++now };
}

test('classifica como verified quando execução e plano terminaram com evidência preservada', () => {
  const { executions, planner, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Corrigir login', ['Editar', 'Testar']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'file', summary: 'auth.ts alterado', reference: 'src/auth.ts' }]);
  planner.startStep('chat-a', 'run-a', plan.steps[1].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[1].id, [{ type: 'test', summary: '12 testes passaram', reference: 'npm test' }]);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.completionProof, 'verified');
  assert.equal(report?.steps.completed, 2);
  assert.equal(report?.evidence.file, 1);
  assert.equal(report?.evidence.test, 1);
  assert.equal(report?.plan?.objective, 'Corrigir login');
  assert.equal(report?.summary?.status, 'completed');
  assert.equal(report?.summary?.facts.testsPassed, 1);
  assert.equal(report?.summary?.facts.testsFailed, 0);
  assert.match(report?.summary?.headline ?? '', /evidência verificada/i);
  assert.equal(report?.summary?.evidenceIds.some((id) => id.startsWith('plan:')), true);
});

test('execução concluída sem plano fica explicitamente unplanned', () => {
  const { executions, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());

  assert.equal(reports.build('chat-a', 'run-a')?.completionProof, 'unplanned');
});

test('plano incompleto nunca recebe prova verified', () => {
  const { executions, planner, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  planner.create('chat-a', 'run-a', 'Tarefa', ['A', 'B']);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.completionProof, 'incomplete');
  assert.equal(report?.steps.pending, 2);
});

test('reconstrói execução histórica depois que snapshot ativo foi removido', () => {
  const { executions, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  executions.update('chat-a', { state: 'failed', error: 'build falhou', runId: 'run-a' }, tick());
  executions.remove('chat-a');

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.state, 'failed');
  assert.equal(report?.completionProof, 'failed');
  assert.equal(report?.error, 'build falhou');
  assert.ok(report?.timeline.some((event) => event.type === 'removed'));
  assert.equal(report?.summary?.status, 'failed');
  assert.equal(report?.summary?.unresolved.includes('build falhou'), true);
});

test('reconstrói execução histórica apenas a partir de recovery baseline', () => {
  const executions = new ExecutionManager();
  const timeline = new ExecutionTimeline();
  const history = new ExecutionPlanHistory();
  timeline.restore([{
    sequence: 1,
    chatId: 'chat-a',
    runId: 'run-recovered',
    at: 5000,
    type: 'recovered',
    state: 'interrupted',
    startedAt: 1000,
  }]);
  const reports = new ExecutionReportBuilder(executions, timeline, history);

  const report = reports.build('chat-a', 'run-recovered');
  assert.equal(report?.state, 'interrupted');
  assert.equal(report?.startedAt, 1000);
  assert.equal(report?.updatedAt, 5000);
  assert.equal(report?.completionProof, 'interrupted');
  assert.equal(report?.summary, undefined);
});

test('execução cancelada preserva estado e resumo evidence-derived sem virar falha', () => {
  const { executions, timeline, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-cancelled');
  timeline.recordStructuredActivity({
    contractVersion: 1,
    id: 'cancelled-read',
    kind: 'tool',
    chatId: 'chat-a',
    runId: 'run-cancelled',
    toolCallId: 'tool-read',
    toolName: 'read_file',
    capabilityId: 'workspace.read_file',
    phase: 'completed',
    createdAt: tick(),
  });
  executions.update('chat-a', { state: 'cancelled', runId: 'run-cancelled' }, tick());

  const report = reports.build('chat-a', 'run-cancelled');
  assert.equal(report?.state, 'cancelled');
  assert.equal(report?.completionProof, 'cancelled');
  assert.equal(report?.summary?.status, 'cancelled');
  assert.match(report?.summary?.headline ?? '', /cancelada/i);
  assert.equal(report?.summary?.evidenceIds.includes('activity:cancelled-read'), true);
  assert.equal(report?.error, undefined);
});

test('lista runs históricas em ordem de atualização e isola chats', () => {
  const { executions, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());
  executions.start('chat-b', tick(), 'run-b');
  executions.update('chat-b', { state: 'completed', runId: 'run-b' }, tick());

  assert.deepEqual(reports.list().map((report) => report.runId), ['run-b', 'run-a']);
  assert.deepEqual(reports.list('chat-a').map((report) => report.runId), ['run-a']);
});

test('histórico arquivado continua disponível no relatório', () => {
  const { executions, planner, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  const plan = planner.create('chat-a', 'run-a', 'Tarefa', ['Passo']);
  planner.startStep('chat-a', 'run-a', plan.steps[0].id);
  planner.completeStep('chat-a', 'run-a', plan.steps[0].id, [{ type: 'result', summary: 'feito' }]);
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());
  planner.remove('chat-a', 'run-a');

  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.completionProof, 'verified');
  assert.equal(report?.planArchived, true);
});


test('execution report exposes factual final tool phases without upgrading completion proof', () => {
  const { executions, timeline, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-a');
  const completed = {
    contractVersion: 1 as const, kind: 'tool', chatId: 'chat-a', runId: 'run-a',
    toolCallId: 'tool-1', toolName: 'run_command', capabilityId: 'command.run', createdAt: tick(),
  };
  timeline.recordStructuredActivity({ ...completed, id: 'tool-1:waiting', phase: 'waiting' });
  timeline.recordStructuredActivity({ ...completed, id: 'tool-1:completed', phase: 'completed', createdAt: tick() });
  timeline.recordStructuredActivity({ ...completed, id: 'tool-2:failed', toolCallId: 'tool-2', toolName: 'inspect_instance', capabilityId: 'instance.inspect', phase: 'failed', createdAt: tick() });
  executions.update('chat-a', { state: 'completed', runId: 'run-a' }, tick());
  const report = reports.build('chat-a', 'run-a');
  assert.equal(report?.recordedTools.observed, 2);
  assert.equal(report?.recordedTools.completed, 1);
  assert.equal(report?.recordedTools.failed, 1);
  assert.equal(report?.recordedTools.waiting, 0);
  assert.deepEqual(report?.recordedTools.tools.map((tool) => tool.toolName), ['run_command', 'inspect_instance']);
  assert.equal(report?.completionProof, 'unplanned');
});


test('evidence-derived run summary counts only observed terminal tool facts', () => {
  const { executions, timeline, reports, tick } = setup();
  executions.start('chat-a', tick(), 'run-summary');
  const events = [
    ['create_file', 'workspace.create_file', 'completed'],
    ['write_file', 'workspace.write_file', 'completed'],
    ['delete_file', 'workspace.delete_file', 'completed'],
    ['create_folder', 'workspace.create_folder', 'completed'],
    ['run_command', 'command.run', 'failed'],
    ['start_process', 'process.start', 'completed'],
    ['open_instance', 'instance.open', 'completed'],
  ] as const;
  events.forEach(([toolName, capabilityId, phase], index) => {
    timeline.recordStructuredActivity({
      contractVersion: 1,
      id: `summary-${index}`,
      kind: 'tool',
      chatId: 'chat-a',
      runId: 'run-summary',
      toolCallId: `call-${index}`,
      toolName,
      capabilityId,
      phase,
      createdAt: tick(),
    });
  });
  executions.update('chat-a', { state: 'completed', runId: 'run-summary' }, tick());

  const report = reports.build('chat-a', 'run-summary');
  assert.deepEqual(report?.summary?.facts, {
    filesCreated: 1,
    filesChanged: 1,
    filesDeleted: 1,
    foldersCreated: 1,
    commandsRun: 1,
    processesStarted: 1,
    instancesOpened: 1,
    testsPassed: 0,
    testsFailed: 0,
    buildsPassed: 0,
    buildsFailed: 0,
  });
  assert.equal(report?.summary?.unresolved.includes('Falha observada em run_command.'), true);
  assert.equal(report?.summary?.evidenceIds.filter((id) => id.startsWith('activity:')).length, events.length);
});
