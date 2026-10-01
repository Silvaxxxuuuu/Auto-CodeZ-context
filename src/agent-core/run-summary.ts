import type { AgentRunSummary, RunSummaryFacts } from './contracts';
import type { OperationalTraceSnapshot } from './operational-trace';
import type { ExecutionReport } from '../execution-report';

const EMPTY_FACTS: RunSummaryFacts = {
  filesCreated: 0,
  filesChanged: 0,
  filesDeleted: 0,
  foldersCreated: 0,
  commandsRun: 0,
  processesStarted: 0,
  instancesOpened: 0,
  testsPassed: 0,
  testsFailed: 0,
  buildsPassed: 0,
  buildsFailed: 0,
};

const FILE_CHANGE_TOOLS = new Set([
  'write_file',
  'replace_range',
  'replace_text',
  'replace_symbol',
  'insert_before',
  'insert_after',
  'rename_file',
]);

function terminalTool(phase: string): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function deriveFacts(report: ExecutionReport): RunSummaryFacts {
  const facts = { ...EMPTY_FACTS };
  for (const tool of report.recordedTools.tools) {
    if (tool.phase === 'completed') {
      if (tool.toolName === 'create_file') facts.filesCreated += 1;
      else if (tool.toolName === 'delete_file') facts.filesDeleted += 1;
      else if (tool.toolName === 'create_folder') facts.foldersCreated += 1;
      else if (FILE_CHANGE_TOOLS.has(tool.toolName)) facts.filesChanged += 1;
      else if (tool.toolName === 'start_process') facts.processesStarted += 1;
      else if (tool.toolName === 'open_instance') facts.instancesOpened += 1;
    }
    if (tool.toolName === 'run_command' && terminalTool(tool.phase)) facts.commandsRun += 1;
  }

  for (const step of report.plan?.steps ?? []) {
    for (const evidence of step.evidence) {
      if (evidence.type === 'test') {
        if (step.status === 'failed') facts.testsFailed += 1;
        else if (step.status === 'completed') facts.testsPassed += 1;
      } else if (evidence.type === 'build') {
        if (step.status === 'failed') facts.buildsFailed += 1;
        else if (step.status === 'completed') facts.buildsPassed += 1;
      }
    }
  }
  return facts;
}

function deriveUnresolved(report: ExecutionReport, trace?: OperationalTraceSnapshot): string[] {
  const unresolved: string[] = [];
  if (report.error) unresolved.push(report.error);
  if (report.completionProof === 'incomplete') unresolved.push('O plano terminou sem comprovação completa.');
  for (const step of report.plan?.steps ?? []) {
    if (step.status === 'pending' || step.status === 'running' || step.status === 'failed') {
      unresolved.push(`Passo ${step.status}: ${step.title}`);
    }
  }
  for (const tool of report.recordedTools.tools) {
    if (tool.phase === 'failed') unresolved.push(`Falha observada em ${tool.toolName}.`);
    else if (tool.phase === 'cancelled') unresolved.push(`${tool.toolName} foi cancelada.`);
  }
  for (const error of trace?.errors ?? []) unresolved.push(error);
  return unique(unresolved).slice(0, 16);
}

function deriveEvidenceIds(report: ExecutionReport, trace?: OperationalTraceSnapshot): string[] {
  const ids: string[] = [];
  for (const event of report.timeline) {
    if (event.type === 'structured_activity' && event.activityId) ids.push(`activity:${event.activityId}`);
  }
  for (const step of report.plan?.steps ?? []) {
    step.evidence.forEach((_evidence, index) => ids.push(`plan:${report.plan!.id}:${step.id}:${index}`));
  }
  for (const entry of trace?.entries ?? []) ids.push(`${entry.source}:${entry.sequence}`);
  return unique(ids).slice(0, 128);
}

function headline(report: ExecutionReport): string {
  if (report.state === 'failed') return 'Execução falhou com evidência operacional registrada.';
  if (report.state === 'cancelled') return 'Execução cancelada com evidência operacional preservada.';
  if (report.completionProof === 'verified') return 'Execução concluída com evidência verificada.';
  if (report.completionProof === 'incomplete') return 'Execução terminou com pendências verificáveis.';
  if (report.recordedTools.observed === 0) return 'Resposta concluída sem operações de ferramenta.';
  return 'Execução concluída com evidência operacional registrada.';
}

export function deriveAgentRunSummary(
  report: ExecutionReport,
  trace?: OperationalTraceSnapshot,
): AgentRunSummary | undefined {
  if (report.state !== 'completed' && report.state !== 'failed' && report.state !== 'cancelled') return undefined;
  const startedAt = report.startedAt ?? report.updatedAt ?? 0;
  const updatedAt = report.updatedAt ?? startedAt;
  return {
    runId: report.runId,
    status: report.state,
    headline: headline(report),
    facts: deriveFacts(report),
    unresolved: deriveUnresolved(report, trace),
    evidenceIds: deriveEvidenceIds(report, trace),
    durationMs: Math.max(0, updatedAt - startedAt),
  };
}
