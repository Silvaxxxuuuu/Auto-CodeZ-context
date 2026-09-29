import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CORE_V2_BASELINE_CAPABILITIES } from '../src/agent-core/baseline-capabilities';
import { assertCapabilityContract } from '../src/agent-core/capability-contract';
import { AGENT_CORE_V2_INVARIANTS } from '../src/agent-core/contracts';
import { assertRunStatusTransition, canTransitionRunStatus, isTerminalRunStatus } from '../src/agent-core/run-lifecycle';

test('Agent Core V2 baseline contracts are structurally valid and uniquely identified', () => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const capability of AGENT_CORE_V2_BASELINE_CAPABILITIES) {
    assert.doesNotThrow(() => assertCapabilityContract(capability));
    assert.equal(ids.has(capability.id), false, `duplicate capability id: ${capability.id}`);
    assert.equal(names.has(capability.name), false, `duplicate capability name: ${capability.name}`);
    ids.add(capability.id);
    names.add(capability.name);
  }
});

test('baseline reserves workspace, persistent process lifecycle and instance semantics', () => {
  const names = new Set(AGENT_CORE_V2_BASELINE_CAPABILITIES.map((capability) => capability.name));
  for (const name of ['create_file', 'create_folder', 'start_process', 'read_process_output', 'wait_process', 'stop_process', 'list_processes', 'open_instance']) {
    assert.equal(names.has(name), true, `missing capability: ${name}`);
  }
});

test('create_file and create_folder are distinct but rollback-capable workspace mutations', () => {
  const createFile = AGENT_CORE_V2_BASELINE_CAPABILITIES.find((capability) => capability.name === 'create_file');
  const createFolder = AGENT_CORE_V2_BASELINE_CAPABILITIES.find((capability) => capability.name === 'create_folder');
  assert.ok(createFile);
  assert.ok(createFolder);
  assert.equal(createFile.category, 'workspace');
  assert.equal(createFolder.category, 'workspace');
  assert.equal(createFile.supportsRollback, true);
  assert.equal(createFolder.supportsRollback, true);
  assert.match(createFile.description, /Diretórios pais ausentes são criados automaticamente/);
  assert.match(createFolder.description, /Não substitui create_file/);
});

test('run lifecycle permits recovery paths but terminal states cannot resume', () => {
  assert.equal(canTransitionRunStatus('queued', 'planning'), true);
  assert.equal(canTransitionRunStatus('running', 'recovering'), true);
  assert.equal(canTransitionRunStatus('recovering', 'running'), true);
  assert.equal(canTransitionRunStatus('waiting_approval', 'running'), true);
  assert.equal(canTransitionRunStatus('completed', 'running'), false);
  assert.equal(canTransitionRunStatus('failed', 'running'), false);
  assert.equal(canTransitionRunStatus('cancelled', 'running'), false);
  assert.equal(isTerminalRunStatus('completed'), true);
  assert.equal(isTerminalRunStatus('running'), false);
  assert.throws(() => assertRunStatusTransition('completed', 'running'), /Transição de execução inválida/);
});

test('Agent Core V2 invariants include execution, recovery, policy, activity and shared-bridge guarantees', () => {
  const values = new Set(AGENT_CORE_V2_INVARIANTS);
  for (const required of [
    'journal-every-mutation',
    'incremental-real-workspace',
    'unrestricted-no-routine-approval',
    'progress-not-round-count',
    'retry-does-not-repeat-side-effects',
    'activity-is-structured',
    'summary-derived-from-evidence',
    'all-bridges-share-capability-policy-execution',
  ] as const) {
    assert.equal(values.has(required), true, `missing invariant: ${required}`);
  }
});

test('capability validator rejects contradictory read-only destructive contracts', () => {
  const base = AGENT_CORE_V2_BASELINE_CAPABILITIES[0];
  assert.ok(base);
  assert.throws(() => assertCapabilityContract({
    ...base,
    id: 'invalid.read-destructive',
    annotations: { ...base.annotations, readOnly: true, destructive: true },
    permissionClass: 'read',
    sideEffects: [],
    supportsRollback: false,
  }), /readOnly e destructive/);
});
