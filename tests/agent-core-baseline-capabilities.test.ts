import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CORE_V2_BASELINE_CAPABILITIES, agentCoreV2CapabilityByName } from '../src/agent-core/baseline-capabilities';
import { assertCapabilityContract } from '../src/agent-core/capability-contract';

const workspaceMutations = [
  'create_file',
  'create_folder',
  'write_file',
  'replace_range',
  'replace_text',
  'replace_symbol',
  'insert_before',
  'insert_after',
  'delete_file',
  'rename_file',
] as const;

test('baseline capability catalog is internally valid and uniquely addressable', () => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const capability of AGENT_CORE_V2_BASELINE_CAPABILITIES) {
    assert.doesNotThrow(() => assertCapabilityContract(capability));
    assert.equal(ids.has(capability.id), false, `duplicate capability id: ${capability.id}`);
    assert.equal(names.has(capability.name), false, `duplicate capability name: ${capability.name}`);
    ids.add(capability.id);
    names.add(capability.name);
    assert.equal(agentCoreV2CapabilityByName(capability.name), capability);
  }
});

test('all real workspace mutation tools have V2 metadata and rollback semantics', () => {
  for (const name of workspaceMutations) {
    const capability = agentCoreV2CapabilityByName(name);
    assert.ok(capability, `missing capability metadata for ${name}`);
    assert.equal(capability.category, 'workspace');
    assert.equal(capability.annotations.readOnly, false);
    assert.equal(capability.annotations.openWorld, false);
    assert.equal(capability.supportsRollback, true);
    assert.notEqual(capability.permissionClass, 'read');
    assert.ok(capability.resourceLocks.length > 0);
  }
});

test('run_command is explicitly open-world, sensitive and non-rollbackable', () => {
  const capability = agentCoreV2CapabilityByName('run_command');
  assert.ok(capability);
  assert.equal(capability.id, 'command.run');
  assert.equal(capability.category, 'process');
  assert.equal(capability.annotations.openWorld, true);
  assert.equal(capability.annotations.readOnly, false);
  assert.equal(capability.supportsRollback, false);
  assert.equal(capability.supportsParallel, false);
  assert.equal(capability.permissionClass, 'sensitive');
});

test('structured process and instance tools remain in the same canonical catalog', () => {
  for (const name of [
    'start_process', 'read_process_output', 'wait_process', 'wait_for_port', 'stop_process', 'list_processes',
    'open_instance', 'instance_status', 'capture_instance', 'inspect_instance', 'interact_instance',
    'focus_instance', 'close_instance', 'list_instances',
  ]) {
    assert.ok(agentCoreV2CapabilityByName(name), `missing capability metadata for ${name}`);
  }
});
