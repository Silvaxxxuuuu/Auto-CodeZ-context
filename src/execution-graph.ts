import type { ExecutionReport } from './execution-report';
import type { ExecutionEvidenceType, ExecutionPlanStepStatus } from './execution-planner';
import type { ExecutionState } from './execution-manager';
import type { ExecutionApprovalDecision } from './execution-timeline';

export type ExecutionGraphNodeKind = 'started' | 'recovered' | 'state' | 'tool' | 'approval' | 'evidence' | 'error';
export type ExecutionGraphNodeSource = 'timeline' | 'plan';

export type ExecutionGraphNode = {
  id: string;
  chatId: string;
  runId: string;
  kind: ExecutionGraphNodeKind;
  source: ExecutionGraphNodeSource;
  at: number;
  label: string;
  state?: ExecutionState;
  tool?: string;
  approvalId?: string;
  approvalDecision?: ExecutionApprovalDecision;
  evidenceType?: ExecutionEvidenceType;
  reference?: string;
  stepId?: string;
  stepTitle?: string;
  stepStatus?: ExecutionPlanStepStatus;
};

export type ExecutionGraphEdge = {
  id: string;
  from: string;
  to: string;
  relation: 'sequence';
};

export type ExecutionGraph = {
  chatId: string;
  runId: string;
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
};

type OrderedNode = ExecutionGraphNode & { order: number };

const STATE_LABELS: Record<ExecutionState, string> = {
  idle: 'Execução ociosa',
  running: 'Execução em andamento',
  waiting_approval: 'Aguardando aprovação',
  completed: 'Execução concluída',
  failed: 'Execução falhou',
  interrupted: 'Execução interrompida',
};

function timelineNodes(report: ExecutionReport): OrderedNode[] {
  const nodes: OrderedNode[] = [];
  for (const event of report.timeline) {
    const base = {
      chatId: report.chatId,
      runId: report.runId,
      source: 'timeline' as const,
      at: event.at,
      order: event.sequence * 10,
    };

    if (event.type === 'started') {
      nodes.push({
        ...base,
        id: `timeline:${event.sequence}:started`,
        kind: 'started',
        label: 'Execução iniciada',
        state: event.state,
      });
      continue;
    }

    if (event.type === 'recovered') {
      nodes.push({
        ...base,
        id: `timeline:${event.sequence}:recovered`,
        kind: 'recovered',
        label: 'Execução recuperada',
        state: event.state,
      });
      continue;
    }

    if (event.type === 'state_changed' && event.state) {
      nodes.push({
        ...base,
        id: `timeline:${event.sequence}:state`,
        kind: 'state',
        label: STATE_LABELS[event.state],
        state: event.state,
      });
      continue;
    }

    if (event.type === 'tool_changed' && event.currentTool) {
      nodes.push({
        ...base,
        id: `timeline:${event.sequence}:tool`,
        kind: 'tool',
        label: event.currentTool,
        state: event.state,
        tool: event.currentTool,
      });
      continue;
    }

    if (event.type === 'approval_decision' && event.approvalDecision && event.approvalId && event.toolName) {
      nodes.push({
        ...base,
        id: `timeline:${event.sequence}:approval`,
        kind: 'approval',
        label: `${event.approvalDecision === 'approved' ? 'Aprovado' : 'Recusado'}: ${event.toolName}`,
        tool: event.toolName,
        approvalId: event.approvalId,
        approvalDecision: event.approvalDecision,
      });
      continue;
    }

    if (event.type === 'error' && event.error) {
      nodes.push({
        ...base,
        id: `timeline:${event.sequence}:error`,
        kind: 'error',
        label: event.error,
        state: event.state,
      });
    }
  }
  return nodes;
}

function evidenceNodes(report: ExecutionReport): OrderedNode[] {
  if (!report.plan) return [];
  const nodes: OrderedNode[] = [];
  report.plan.steps.forEach((step, stepIndex) => {
    step.evidence.forEach((evidence, evidenceIndex) => {
      nodes.push({
        id: `plan:${report.plan!.id}:step:${step.id}:evidence:${evidenceIndex}`,
        chatId: report.chatId,
        runId: report.runId,
        kind: 'evidence',
        source: 'plan',
        at: evidence.createdAt,
        order: 1_000_000 + stepIndex * 1000 + evidenceIndex,
        label: evidence.summary,
        evidenceType: evidence.type,
        reference: evidence.reference,
        stepId: step.id,
        stepTitle: step.title,
        stepStatus: step.status,
      });
    });
  });
  return nodes;
}

function compareNodes(left: OrderedNode, right: OrderedNode): number {
  if (left.at !== right.at) return left.at - right.at;
  if (left.source !== right.source) return left.source === 'timeline' ? -1 : 1;
  if (left.order !== right.order) return left.order - right.order;
  return left.id.localeCompare(right.id);
}

export function buildExecutionGraph(report: ExecutionReport): ExecutionGraph {
  if (!report || typeof report !== 'object') throw new Error('Relatório de execução inválido.');
  if (typeof report.chatId !== 'string' || !report.chatId.trim()) throw new Error('Chat do relatório inválido.');
  if (typeof report.runId !== 'string' || !report.runId.trim()) throw new Error('Execução do relatório inválida.');

  const ordered = [...timelineNodes(report), ...evidenceNodes(report)].sort(compareNodes);
  const nodes = ordered.map(({ order: _order, ...node }) => node);
  const edges: ExecutionGraphEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1].id;
    const to = nodes[index].id;
    edges.push({ id: `sequence:${from}->${to}`, from, to, relation: 'sequence' });
  }

  return {
    chatId: report.chatId,
    runId: report.runId,
    nodes,
    edges,
  };
}
