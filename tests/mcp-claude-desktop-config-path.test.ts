import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveClaudeDesktopConfigPath } from '../src/mcp-gateway/claude-desktop-config-path';

test('Claude Desktop config uses normal roaming path when no MSIX package exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-claude-path-'));
  try {
    const appDataRoot = path.join(root, 'Roaming');
    const localAppDataRoot = path.join(root, 'Local');
    const resolved = await resolveClaudeDesktopConfigPath({ appDataRoot, localAppDataRoot, platform: 'win32' });
    assert.equal(resolved, path.join(appDataRoot, 'Claude', 'claude_desktop_config.json'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Claude Desktop config targets the Windows MSIX virtualized roaming path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-claude-msix-'));
  try {
    const appDataRoot = path.join(root, 'Roaming');
    const localAppDataRoot = path.join(root, 'Local');
    const packageRoot = path.join(localAppDataRoot, 'Packages', 'Claude_pzs8sxrjxfjjc');
    await fs.mkdir(packageRoot, { recursive: true });
    const resolved = await resolveClaudeDesktopConfigPath({ appDataRoot, localAppDataRoot, platform: 'win32' });
    assert.equal(resolved, path.join(packageRoot, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Claude Desktop config falls back to a single future Claude MSIX family', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-claude-msix-future-'));
  try {
    const appDataRoot = path.join(root, 'Roaming');
    const localAppDataRoot = path.join(root, 'Local');
    const packageRoot = path.join(localAppDataRoot, 'Packages', 'Claude_futurefamily');
    await fs.mkdir(packageRoot, { recursive: true });
    const resolved = await resolveClaudeDesktopConfigPath({ appDataRoot, localAppDataRoot, platform: 'win32' });
    assert.equal(resolved, path.join(packageRoot, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
