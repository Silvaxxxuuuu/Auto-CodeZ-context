import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeDesktopExtensionManager } from '../src/mcp-gateway/claude-desktop-extension';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-claude-extension-'));
  const extensionRoot = path.join(root, 'auto-codez-extension');
  const claudeUserDataPath = path.join(root, 'Claude');
  const manager = new ClaudeDesktopExtensionManager({
    extensionRoot,
    claudeUserDataPath,
    brokerAddress: '\\\\.\\pipe\\auto-codez-test',
    appPath: 'C:\\Program Files\\Auto CodeZ\\Auto CodeZ.exe',
    appVersion: '2.0.0-alpha.1',
    platform: 'win32',
  });
  return { root, extensionRoot, claudeUserDataPath, manager };
}

test('Claude Desktop extension is prepared as a Node MCPB-compatible unpacked extension without secrets', async () => {
  const f = await fixture();
  try {
    const status = await f.manager.prepare();
    assert.equal(status.state, 'prepared');
    assert.equal(status.unpackedPath, f.extensionRoot);
    assert.equal(status.bundlePath, path.join(path.dirname(f.extensionRoot), 'auto-codez.mcpb'));
    const manifest = JSON.parse(await fs.readFile(path.join(f.extensionRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, '0.3');
    assert.equal(manifest.name, 'auto-codez');
    assert.equal(manifest.server.type, 'node');
    assert.equal(manifest.server.entry_point, 'server/index.cjs');
    assert.equal(manifest.tools_generated, true);
    const server = await fs.readFile(path.join(f.extensionRoot, 'server', 'index.cjs'), 'utf8');
    assert.match(server, /auto-codez-test/);
    assert.match(server, /claude-desktop/);
    assert.doesNotMatch(server, /Bearer\s+[A-Za-z0-9._-]{16,}/);
    assert.doesNotMatch(server, /bearerToken\s*[:=]\s*['"][^'"]{16,}/);
    const bundle = await fs.readFile(status.bundlePath);
    assert.equal(bundle.readUInt32LE(0), 0x04034b50);
    assert.ok(bundle.includes(Buffer.from('manifest.json')));
    assert.ok(bundle.includes(Buffer.from('server/index.cjs')));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('Claude Desktop extension only reports configured when Claude registry contains Auto CodeZ', async () => {
  const f = await fixture();
  try {
    await f.manager.prepare();
    await fs.mkdir(f.claudeUserDataPath, { recursive: true });
    await fs.writeFile(path.join(f.claudeUserDataPath, 'extensions-installations.json'), JSON.stringify({
      extensions: {
        'local.unpacked.auto-codez': {
          id: 'local.unpacked.auto-codez',
          manifest: { name: 'auto-codez', version: '2.0.0-alpha.1' },
          settings: { isEnabled: true },
        },
      },
    }), 'utf8');
    const status = await f.manager.status();
    assert.equal(status.state, 'configured');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('removing prepared files never pretends to uninstall an extension already registered by Claude', async () => {
  const f = await fixture();
  try {
    await f.manager.prepare();
    await fs.mkdir(f.claudeUserDataPath, { recursive: true });
    await fs.writeFile(path.join(f.claudeUserDataPath, 'extensions-installations.json'), JSON.stringify({
      extensions: {
        installed: { manifest: { name: 'auto-codez' } },
      },
    }), 'utf8');
    const status = await f.manager.removePrepared();
    assert.equal(status.state, 'configured');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
