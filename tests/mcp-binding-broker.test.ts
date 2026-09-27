import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McpGatewayBindingBroker, mcpBindingBrokerAddress, readMcpGatewayBindingFromBroker } from '../src/mcp-gateway/binding-broker';

test('MCP binding broker shares an ephemeral gateway binding over local IPC', async () => {
  const appData = path.join(os.tmpdir(), `auto-codez-broker-${process.pid}-${Date.now()}`);
  const address = mcpBindingBrokerAddress(appData);
  const expected = {
    endpoint: 'http://127.0.0.1:49152/mcp',
    bearerToken: 'z'.repeat(48),
    ownerPid: process.pid,
    updatedAt: Date.now(),
  };
  const broker = new McpGatewayBindingBroker(address, async () => expected);
  await broker.start();
  try {
    assert.deepEqual(await readMcpGatewayBindingFromBroker(address), expected);
  } finally {
    await broker.stop();
  }
  assert.equal(await readMcpGatewayBindingFromBroker(address), undefined);
});

test('MCP binding broker returns no secret while gateway binding is unavailable', async () => {
  const appData = path.join(os.tmpdir(), `auto-codez-broker-empty-${process.pid}-${Date.now()}`);
  const address = mcpBindingBrokerAddress(appData);
  const broker = new McpGatewayBindingBroker(address, async () => undefined);
  await broker.start();
  try {
    assert.equal(await readMcpGatewayBindingFromBroker(address), undefined);
  } finally {
    await broker.stop();
  }
});
