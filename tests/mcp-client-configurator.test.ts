import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McpClientConfigurator } from '../src/mcp-gateway/client-configurator';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-cursor-mcp-'));
  const configPath = path.join(root, '.cursor', 'mcp.json');
  const bridgeScriptPath = path.join(root, 'mcp-bridge.ps1');
  await fs.writeFile(bridgeScriptPath, 'Write-Output bridge', 'utf8');
  const runtime = new McpClientConfigurator({
    cursorConfigPath: configPath,
    bridgeScriptPath,
    brokerAddress: '\\\\.\\pipe\\auto-codez-mcp-test',
    appPath: 'C:\\Program Files\\Auto CodeZ\\Auto CodeZ.exe',
    platform: 'win32',
  });
  return { root, configPath, runtime, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('Cursor adapter installs Auto CodeZ globally without touching unrelated MCP servers', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.configPath), { recursive: true });
    await fs.writeFile(f.configPath, JSON.stringify({
      theme: 'system',
      mcpServers: {
        existing: { command: 'existing.exe', args: ['serve'] },
      },
    }), 'utf8');

    const status = await f.runtime.install('cursor');
    assert.equal(status.state, 'configured');

    const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert.equal(config.theme, 'system');
    assert.deepEqual(config.mcpServers.existing, { command: 'existing.exe', args: ['serve'] });
    assert.equal(config.mcpServers['auto-codez'].command, 'powershell.exe');
    assert.ok(config.mcpServers['auto-codez'].args.includes('-BrokerAddress'));
    assert.ok(config.mcpServers['auto-codez'].args.includes('-ClientId'));
    assert.ok(config.mcpServers['auto-codez'].args.includes('cursor'));
    assert.equal(JSON.stringify(config).includes('Bearer '), false);
  } finally {
    await f.cleanup();
  }
});

test('Cursor adapter is idempotent and removes only its own managed entry', async () => {
  const f = await fixture();
  try {
    await f.runtime.install('cursor');
    await f.runtime.install('cursor');
    assert.equal((await f.runtime.status('cursor')).state, 'configured');

    const removed = await f.runtime.remove('cursor');
    assert.equal(removed.state, 'not-configured');
    const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert.equal(config.mcpServers, undefined);
  } finally {
    await f.cleanup();
  }
});

test('Cursor adapter refuses to overwrite or remove a conflicting server name', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.configPath), { recursive: true });
    await fs.writeFile(f.configPath, JSON.stringify({
      mcpServers: {
        'auto-codez': { command: 'custom.exe', args: [] },
      },
    }), 'utf8');

    assert.equal((await f.runtime.status('cursor')).state, 'conflict');
    await assert.rejects(() => f.runtime.install('cursor'), /não vai sobrescrever/);
    await assert.rejects(() => f.runtime.remove('cursor'), /não pertence/);
  } finally {
    await f.cleanup();
  }
});

test('Cursor adapter refuses malformed existing JSON instead of overwriting it', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.configPath), { recursive: true });
    await fs.writeFile(f.configPath, '{broken', 'utf8');
    await assert.rejects(() => f.runtime.install('cursor'), /JSON inválido/);
  } finally {
    await f.cleanup();
  }
});
