import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AGENT_CORE_V2_INVARIANTS, type AgentCoreV2Invariant } from '../src/agent-core/contracts';

const acceptanceEvidence: Record<AgentCoreV2Invariant, readonly string[]> = {
  'evidence-before-success': [
    'tests/agent-core-incremental-workspace.test.ts',
    'tests/execution-report.test.ts',
  ],
  'journal-every-mutation': [
    'tests/agent-core-operation-journal.test.ts',
    'tests/agent-core-shadow-parity-acceptance.test.ts',
  ],
  'incremental-real-workspace': [
    'tests/agent-core-shadow-parity-acceptance.test.ts',
    'tests/agent-core-tool-runtime-bridge.test.ts',
  ],
  'atomic-file-write': [
    'tests/agent-core-incremental-workspace.test.ts',
    'tests/agent-core-operation-rollback.test.ts',
  ],
  'unrestricted-no-routine-approval': [
    'tests/agent-runtime-unrestricted.test.ts',
    'tests/agent-core-process-instance-acceptance.test.ts',
  ],
  'security-remains-active': [
    'tests/tool-policy-runtime.test.ts',
    'tests/project-manager-context-security.test.ts',
  ],
  'progress-not-round-count': [
    'tests/agent-core-progress-watchdog.test.ts',
    'tests/agent-runtime.test.ts',
  ],
  'partial-work-survives': [
    'tests/execution-recovery-determinism.test.ts',
    'tests/agent-recovery.test.ts',
  ],
  'retry-does-not-repeat-side-effects': [
    'tests/response-retry.test.ts',
    'tests/provider-request-journal.test.ts',
  ],
  'processes-have-lifecycle': [
    'tests/agent-core-process-instance-acceptance.test.ts',
    'tests/process-runtime.test.ts',
  ],
  'instances-have-lifecycle': [
    'tests/agent-core-process-instance-acceptance.test.ts',
    'tests/instance-runtime.test.ts',
  ],
  'activity-is-structured': [
    'tests/activity-runtime.test.ts',
    'tests/tool-activity-bridge.test.ts',
  ],
  'trace-is-not-ui': [
    'tests/operational-trace.test.ts',
    'tests/operational-ledger-retrieval.test.ts',
  ],
  'summary-derived-from-evidence': [
    'tests/execution-report.test.ts',
  ],
  'provider-adapters-normalize': [
    'tests/provider-normalization.test.ts',
    'tests/provider-adapters.test.ts',
  ],
  'context-compiler-is-authoritative': [
    'tests/context-compiler.test.ts',
    'tests/agent-core-baseline-capabilities.test.ts',
  ],
  'memory-and-personalization-provider-independent': [
    'tests/account-memory-runtime.test.ts',
    'tests/account-personalization-runtime.test.ts',
    'tests/context-compiler.test.ts',
  ],
  'all-bridges-share-capability-policy-execution': [
    'tests/mcp-gateway-execution-runtime.test.ts',
    'tests/plugin-tool-gateway.test.ts',
    'tests/tool-policy-runtime.test.ts',
  ],
  'cancellation-is-consistent': [
    'tests/tool-runtime-cancellation.test.ts',
    'tests/recovery-controller.test.ts',
    'tests/execution-report.test.ts',
  ],
};

test('Agent Core V2 acceptance matrix covers every canonical invariant exactly once', () => {
  assert.deepEqual(
    Object.keys(acceptanceEvidence).sort(),
    [...AGENT_CORE_V2_INVARIANTS].sort(),
  );
});

test('every Agent Core V2 invariant points to concrete automated evidence', async () => {
  for (const invariant of AGENT_CORE_V2_INVARIANTS) {
    const evidence = acceptanceEvidence[invariant];
    assert.ok(evidence.length > 0, `Sem evidência automatizada para ${invariant}`);

    for (const relative of evidence) {
      const absolute = path.resolve(process.cwd(), relative);
      const content = await fs.readFile(absolute, 'utf8');
      assert.match(
        content,
        /\btest\s*\(/,
        `Evidência de ${invariant} não contém teste executável: ${relative}`,
      );
    }
  }
});
