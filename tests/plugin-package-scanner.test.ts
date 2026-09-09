import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanPluginPackages } from '../src/plugins/plugin-package-scanner';
import { PLUGIN_API_VERSION } from '../src/plugins/plugin-types';

async function withTempRoot(action: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugins-'));
  try {
    await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writePlugin(root: string, directory: string, manifest: Record<string, unknown>, main = 'dist/main.js'): Promise<void> {
  const pluginRoot = path.join(root, directory);
  await fs.mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
    apiVersion: PLUGIN_API_VERSION,
    id: directory,
    name: directory,
    version: '1.0.0',
    contributions: [],
    permissions: [],
    main,
    ...manifest,
  }), 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'dist', 'main.js'), 'export default {}', 'utf8');
}

test('plugin package scanner discovers valid packages without executing them', async () => {
  await withTempRoot(async (root) => {
    await writePlugin(root, 'safe.plugin', { contributions: ['command'], permissions: [] });
    const result = await scanPluginPackages(root);
    assert.equal(result.failures.length, 0);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].manifest.id, 'safe.plugin');
    assert.equal(path.basename(result.packages[0].mainPath || ''), 'main.js');
  });
});

test('plugin package scanner isolates malformed packages instead of failing the whole scan', async () => {
  await withTempRoot(async (root) => {
    await writePlugin(root, 'good.plugin', {});
    const badRoot = path.join(root, 'bad.plugin');
    await fs.mkdir(badRoot, { recursive: true });
    await fs.writeFile(path.join(badRoot, 'plugin.json'), '{broken', 'utf8');
    const result = await scanPluginPackages(root);
    assert.deepEqual(result.packages.map((item) => item.manifest.id), ['good.plugin']);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].directory, 'bad.plugin');
    assert.match(result.failures[0].reason, /JSON inválido/i);
  });
});

test('plugin package scanner rejects duplicate plugin identities', async () => {
  await withTempRoot(async (root) => {
    await writePlugin(root, 'one.plugin', { id: 'shared.plugin' });
    await writePlugin(root, 'two.plugin', { id: 'shared.plugin' });
    const result = await scanPluginPackages(root);
    assert.equal(result.packages.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].reason, /duplicado/i);
  });
});
