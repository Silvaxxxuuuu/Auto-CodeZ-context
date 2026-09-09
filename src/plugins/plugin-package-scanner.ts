import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePluginManifest } from './plugin-manifest';
import type { PluginManifest } from './plugin-types';

const MANIFEST_NAME = 'plugin.json';
const MAX_PLUGIN_DIRECTORIES = 256;
const MAX_MANIFEST_BYTES = 128 * 1024;

export type DiscoveredPluginPackage = {
  rootPath: string;
  manifestPath: string;
  manifest: PluginManifest;
  mainPath?: string;
};

export type PluginPackageFailure = {
  directory: string;
  reason: string;
};

export type PluginPackageScanResult = {
  packages: DiscoveredPluginPackage[];
  failures: PluginPackageFailure[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readManifest(manifestPath: string): Promise<PluginManifest> {
  const stat = await fs.stat(manifestPath);
  if (!stat.isFile()) throw new Error('plugin.json não é um arquivo regular.');
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('plugin.json excede o limite de 128 KB.');
  const raw = await fs.readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('plugin.json contém JSON inválido.');
  }
  return validatePluginManifest(parsed);
}

async function inspectPackage(directory: string): Promise<DiscoveredPluginPackage> {
  const rootPath = await fs.realpath(directory);
  const rootStat = await fs.stat(rootPath);
  if (!rootStat.isDirectory()) throw new Error('Pacote de plugin não é um diretório.');

  const manifestPath = path.join(rootPath, MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  if (!manifest.main) return { rootPath, manifestPath, manifest };

  const requestedMain = path.resolve(rootPath, manifest.main);
  if (!isInside(rootPath, requestedMain)) throw new Error('Entry point do plugin saiu da pasta do pacote.');
  const mainPath = await fs.realpath(requestedMain);
  if (!isInside(rootPath, mainPath)) throw new Error('Entry point do plugin resolve para fora da pasta do pacote.');
  const mainStat = await fs.stat(mainPath);
  if (!mainStat.isFile()) throw new Error('Entry point do plugin não é um arquivo regular.');
  return { rootPath, manifestPath, manifest, mainPath };
}

export async function scanPluginPackages(pluginsRoot: string): Promise<PluginPackageScanResult> {
  const resolvedRoot = path.resolve(pluginsRoot);
  await fs.mkdir(resolvedRoot, { recursive: true });
  const rootPath = await fs.realpath(resolvedRoot);
  const entries = (await fs.readdir(rootPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PLUGIN_DIRECTORIES);

  const packages: DiscoveredPluginPackage[] = [];
  const failures: PluginPackageFailure[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    const directory = path.join(rootPath, entry.name);
    try {
      const discovered = await inspectPackage(directory);
      if (seenIds.has(discovered.manifest.id)) throw new Error(`Plugin '${discovered.manifest.id}' está duplicado.`);
      seenIds.add(discovered.manifest.id);
      packages.push(discovered);
    } catch (error) {
      failures.push({ directory: entry.name, reason: errorMessage(error).slice(0, 2048) });
    }
  }
  return { packages, failures };
}
