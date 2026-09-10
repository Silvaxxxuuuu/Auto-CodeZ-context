import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PluginPackageInstaller } from '../src/plugins/plugin-package-installer';

async function writePackage(root: string, version: string, source: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify({
    apiVersion: 1,
    id: 'installer.test',
    name: 'Installer Test',
    version,
    main: 'index.js',
    contributions: ['tool'],
    permissions: ['ai:tool'],
  }), 'utf8');
  await writeFile(path.join(root, 'index.js'), source, 'utf8');
}

test('plugin installer copies a validated package into managed storage', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugin-installer-'));
  const source = path.join(temp, 'source');
  const managed = path.join(temp, 'managed');
  try {
    await writePackage(source, '1.0.0', 'autoCodez.register({});\n');
    const installer = new PluginPackageInstaller(managed);
    const installed = await installer.install(source);

    assert.equal(installed.manifest.id, 'installer.test');
    assert.equal(installed.manifest.version, '1.0.0');
    assert.equal(installed.rootPath, await realpath(path.join(managed, 'installer.test')));
    assert.equal(await readFile(path.join(managed, 'installer.test', 'index.js'), 'utf8'), 'autoCodez.register({});\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('plugin installer atomically replaces an existing version and uninstall is idempotent', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugin-update-'));
  const source = path.join(temp, 'source');
  const managed = path.join(temp, 'managed');
  try {
    const installer = new PluginPackageInstaller(managed);
    await writePackage(source, '1.0.0', 'const version = 1;\n');
    await installer.install(source);

    await rm(source, { recursive: true, force: true });
    await writePackage(source, '2.0.0', 'const version = 2;\n');
    const updated = await installer.install(source);

    assert.equal(updated.manifest.version, '2.0.0');
    assert.equal(await readFile(path.join(managed, 'installer.test', 'index.js'), 'utf8'), 'const version = 2;\n');
    const managedEntries = await readdir(managed);
    assert.deepEqual(managedEntries, ['installer.test']);

    await installer.uninstall('installer.test');
    await installer.uninstall('installer.test');
    const remaining = await readdir(managed);
    assert.deepEqual(remaining, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('plugin installer rejects an entry point that escapes the source package', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugin-traversal-'));
  const source = path.join(temp, 'source');
  const managed = path.join(temp, 'managed');
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(temp, 'outside.js'), 'outside', 'utf8');
    await writeFile(path.join(source, 'plugin.json'), JSON.stringify({
      apiVersion: 1,
      id: 'installer.test',
      name: 'Installer Test',
      version: '1.0.0',
      main: '../outside.js',
      contributions: [],
      permissions: [],
    }), 'utf8');
    const installer = new PluginPackageInstaller(managed);
    await assert.rejects(() => installer.install(source), /Campo 'main'|Entry point|pasta do pacote/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
