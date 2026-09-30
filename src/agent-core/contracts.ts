export const AGENT_CORE_V2_CONTRACT_VERSION = 1 as const;

export type AgentRunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'waiting_external'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CapabilityCategory =
  | 'workspace'
  | 'process'
  | 'instance'
  | 'git'
  | 'web'
  | 'integration'
  | 'plugin'
  | 'internal';

export type CapabilityPermissionClass = 'read' | 'write' | 'sensitive' | 'external';

export type CapabilityAnnotations = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export type CapabilityActivityTemplate = {
  running: string;
  completed: string;
  failed: string;
};

export type CapabilityContract = {
  contractVersion: typeof AGENT_CORE_V2_CONTRACT_VERSION;
  id: string;
  name: string;
  title: string;
  category: CapabilityCategory;
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  examples: string[];
  failureModes: string[];
  sideEffects: string[];
  annotations: CapabilityAnnotations;
  requiresWorkspace: boolean;
  supportsRollback: boolean;
  supportsParallel: boolean;
  resourceLocks: string[];
  permissionClass: CapabilityPermissionClass;
  activity: CapabilityActivityTemplate;
  version: number;
};

export type AgentEvidenceType =
  | 'file'
  | 'directory'
  | 'command'
  | 'process'
  | 'instance'
  | 'test'
  | 'build'
  | 'web'
  | 'plugin'
  | 'integration'
  | 'result';

export type AgentEvidence = {
  id: string;
  runId: string;
  toolCallId?: string;
  operationId?: string;
  type: AgentEvidenceType;
  summary: string;
  reference?: string;
  createdAt: number;
};

export type OperationJournalStatus =
  | 'prepared'
  | 'executing'
  | 'verified'
  | 'failed'
  | 'rolled_back'
  | 'rollback_conflict';

export type OperationSnapshot = {
  exists: boolean;
  kind?: 'file' | 'directory';
  hash?: string;
  size?: number;
  modifiedAt?: number;
  contentRef?: string;
};

export type OperationJournalResource = {
  target: string;
  before: OperationSnapshot;
  after?: OperationSnapshot;
  rollbackRef?: string;
};

export type OperationJournalRecord = {
  contractVersion: typeof AGENT_CORE_V2_CONTRACT_VERSION;
  operationId: string;
  runId: string;
  toolCallId: string;
  capabilityId: string;
  projectId: string;
  target: string;
  resources: OperationJournalResource[];
  status: OperationJournalStatus;
  createdAt: number;
  updatedAt: number;
  verifiedAt?: number;
  error?: string;
};

export type StructuredActivityPhase =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StructuredActivitySubject = {
  path?: string;
  command?: string;
  processId?: string;
  instanceId?: string;
  url?: string;
  label?: string;
};

export type StructuredActivityEvent = {
  contractVersion: typeof AGENT_CORE_V2_CONTRACT_VERSION;
  id: string;
  kind: string;
  phase: StructuredActivityPhase;
  runId: string;
  chatId?: string;
  toolCallId?: string;
  toolName?: string;
  operationId?: string;
  capabilityId?: string;
  subject?: StructuredActivitySubject;
  summary?: string;
  durationMs?: number;
  createdAt: number;
};

export type RunSummaryFacts = {
  filesCreated: number;
  filesChanged: number;
  filesDeleted: number;
  foldersCreated: number;
  commandsRun: number;
  processesStarted: number;
  instancesOpened: number;
  testsPassed: number;
  testsFailed: number;
  buildsPassed: number;
  buildsFailed: number;
};

export type AgentRunSummary = {
  runId: string;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  headline: string;
  facts: RunSummaryFacts;
  unresolved: string[];
  evidenceIds: string[];
  durationMs: number;
};

export type ProcessHandle = {
  processId: string;
  pid: number;
  command: string;
  cwd: string;
  status: 'starting' | 'running' | 'exited' | 'failed' | 'stopped';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
};

export type InstanceKind = 'application' | 'url' | 'file' | 'folder' | 'preview';

export type InstanceHandle = {
  instanceId: string;
  kind: InstanceKind;
  target: string;
  status: 'opening' | 'open' | 'closed' | 'failed';
  openedAt: number;
  closedAt?: number;
};

export type AgentCoreV2Invariant =
  | 'evidence-before-success'
  | 'journal-every-mutation'
  | 'incremental-real-workspace'
  | 'atomic-file-write'
  | 'unrestricted-no-routine-approval'
  | 'security-remains-active'
  | 'progress-not-round-count'
  | 'partial-work-survives'
  | 'retry-does-not-repeat-side-effects'
  | 'processes-have-lifecycle'
  | 'instances-have-lifecycle'
  | 'activity-is-structured'
  | 'trace-is-not-ui'
  | 'summary-derived-from-evidence'
  | 'provider-adapters-normalize'
  | 'context-compiler-is-authoritative'
  | 'memory-and-personalization-provider-independent'
  | 'all-bridges-share-capability-policy-execution';

export const AGENT_CORE_V2_INVARIANTS: readonly AgentCoreV2Invariant[] = [
  'evidence-before-success',
  'journal-every-mutation',
  'incremental-real-workspace',
  'atomic-file-write',
  'unrestricted-no-routine-approval',
  'security-remains-active',
  'progress-not-round-count',
  'partial-work-survives',
  'retry-does-not-repeat-side-effects',
  'processes-have-lifecycle',
  'instances-have-lifecycle',
  'activity-is-structured',
  'trace-is-not-ui',
  'summary-derived-from-evidence',
  'provider-adapters-normalize',
  'context-compiler-is-authoritative',
  'memory-and-personalization-provider-independent',
  'all-bridges-share-capability-policy-execution',
] as const;
