import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McpClientConfigurator } from '../src/mcp-gateway/client-configurator';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-cursor-mcp-'));
  const configPath = path.join(root, '.cursor', 'mcp.json');
  const codexConfigPath = path.join(root, '.codex', 'config.toml');
  const bridgeScriptPath = path.join(root, 'mcp-bridge.ps1');
  await fs.writeFile(bridgeScriptPath, 'Write-Output bridge', 'utf8');
  const runtime = new McpClientConfigurator({
    cursorConfigPath: configPath,
    codexConfigPath,
    bridgeScriptPath,
    brokerAddress: '\\\\.\\pipe\\auto-codez-mcp-test',
    appPath: 'C:\\Program Files\\Auto CodeZ\\Auto CodeZ.exe',
    platform: 'win32',
  });
  return { root, configPath, codexConfigPath, runtime, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
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


test('Codex adapter appends a managed stdio block without changing existing TOML', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.codexConfigPath), { recursive: true });
    await fs.writeFile(f.codexConfigPath, 'model = "gpt-5.6"\n\n[mcp_servers.existing]\ncommand = "existing.exe"\nargs = ["serve"]\n', 'utf8');

    const status = await f.runtime.install('codex');
    assert.equal(status.state, 'configured');

    const text = await fs.readFile(f.codexConfigPath, 'utf8');
    assert.match(text, /model = "gpt-5\.6"/);
    assert.match(text, /\[mcp_servers\.existing\]/);
    assert.match(text, /# >>> Auto CodeZ MCP: auto-codez/);
    assert.match(text, /\[mcp_servers\.auto-codez\]/);
    assert.match(text, /command = "powershell\.exe"/);
    assert.match(text, /"codex"/);
    assert.equal(text.includes('Bearer '), false);
    assert.equal(text.includes('bearerToken'), false);
  } finally {
    await f.cleanup();
  }
});

test('Codex adapter is idempotent and removes only its managed block', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.codexConfigPath), { recursive: true });
    await fs.writeFile(f.codexConfigPath, 'model = "gpt-5.6"\n', 'utf8');

    await f.runtime.install('codex');
    await f.runtime.install('codex');
    assert.equal((await f.runtime.status('codex')).state, 'configured');

    const installed = await fs.readFile(f.codexConfigPath, 'utf8');
    assert.equal((installed.match(/# >>> Auto CodeZ MCP: auto-codez/g) ?? []).length, 1);

    const removed = await f.runtime.remove('codex');
    assert.equal(removed.state, 'not-configured');
    assert.equal((await fs.readFile(f.codexConfigPath, 'utf8')).trim(), 'model = "gpt-5.6"');
  } finally {
    await f.cleanup();
  }
});

test('Codex adapter refuses an external auto-codez table instead of overwriting it', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.codexConfigPath), { recursive: true });
    await fs.writeFile(f.codexConfigPath, '[mcp_servers.auto-codez]\ncommand = "custom.exe"\n', 'utf8');

    assert.equal((await f.runtime.status('codex')).state, 'conflict');
    await assert.rejects(() => f.runtime.install('codex'), /não vai sobrescrever/);
    await assert.rejects(() => f.runtime.remove('codex'), /não pertence/);
  } finally {
    await f.cleanup();
  }
});
