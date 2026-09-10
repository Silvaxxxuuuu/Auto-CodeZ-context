import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPluginPackage, type DiscoveredPluginPackage } from './plugin-package-scanner';

const MAX_PACKAGE_FILES = 2048;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function collectFiles(root: string): Promise<Array<{ source: string; relative: string; size: number }>> {
  const files: Array<{ source: string; relative: string; size: number }> = [];
  const queue = [''];
  let totalBytes = 0;
  while (queue.length) {
    const relativeDir = queue.shift()!;
    const directory = path.join(root, relativeDir);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(relativeDir, entry.name);
      const source = path.join(root, relative);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`Pacote contém link simbólico não permitido: ${relative}.`);
      if (stat.isDirectory()) {
        queue.push(relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Pacote contém entrada não suportada: ${relative}.`);
      if (stat.size > MAX_SINGLE_FILE_BYTES) throw new Error(`Arquivo do plugin excede 8 MB: ${relative}.`);
      totalBytes += stat.size;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error('Pacote do plugin excede 64 MB.');
      files.push({ source, relative, size: stat.size });
      if (files.length > MAX_PACKAGE_FILES) throw new Error('Pacote do plugin excede 2048 arquivos.');
    }
  }
  return files;
}

async function copyPackage(sourceRoot: string, destinationRoot: string): Promise<void> {
  const files = await collectFiles(sourceRoot);
  await fs.mkdir(destinationRoot, { recursive: true });
  for (const file of files) {
    const destination = path.join(destinationRoot, file.relative);
    if (!isInside(destinationRoot, destination)) throw new Error('Caminho de pacote inválido.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(file.source, destination, fs.constants.COPYFILE_EXCL);
  }
}

export class PluginPackageInstaller {
  constructor(private readonly pluginsRoot: string) {}

  async install(sourceDirectory: string): Promise<DiscoveredPluginPackage> {
    const source = await inspectPluginPackage(sourceDirectory);
    await fs.mkdir(this.pluginsRoot, { recursive: true });
    const managedRoot = await fs.realpath(this.pluginsRoot);
    const destination = path.join(managedRoot, source.manifest.id);
    if (!isInside(managedRoot, destination)) throw new Error('Destino de plugin inválido.');
    const token = crypto.randomUUID();
    const staging = path.join(managedRoot, `.install-${source.manifest.id}-${token}`);
    const backup = path.join(managedRoot, `.backup-${source.manifest.id}-${token}`);
    let backedUp = false;

    try {
      await copyPackage(source.rootPath, staging);
      const staged = await inspectPluginPackage(staging);
      if (staged.manifest.id !== source.manifest.id || staged.manifest.version !== source.manifest.version) {
        throw new Error('Pacote copiado não corresponde ao manifesto validado.');
      }
      try {
        await fs.rename(destination, backup);
        backedUp = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await fs.rename(staging, destination);
      if (backedUp) await fs.rm(backup, { recursive: true, force: true });
      return inspectPluginPackage(destination);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch((): undefined => undefined);
      if (backedUp) {
        await fs.rm(destination, { recursive: true, force: true }).catch((): undefined => undefined);
        await fs.rename(backup, destination).catch((): undefined => undefined);
      }
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch((): undefined => undefined);
      await fs.rm(backup, { recursive: true, force: true }).catch((): undefined => undefined);
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(pluginId)) throw new Error('ID de plugin inválido.');
    await fs.mkdir(this.pluginsRoot, { recursive: true });
    const managedRoot = await fs.realpath(this.pluginsRoot);
    const destination = path.join(managedRoot, pluginId);
    if (!isInside(managedRoot, destination)) throw new Error('Destino de plugin inválido.');
    const stat = await fs.lstat(destination).catch(() => undefined);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Pacote gerenciado resolve para link simbólico inesperado.');
    await fs.rm(destination, { recursive: true, force: true });
  }
}
