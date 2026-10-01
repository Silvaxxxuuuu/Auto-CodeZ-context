import fs from 'node:fs/promises';
import path from 'node:path';

const CLAUDE_DESKTOP_MSIX_FAMILY = 'Claude_pzs8sxrjxfjjc';

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeDesktopConfigPath(input: {
  appDataRoot: string;
  localAppDataRoot?: string;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const standard = path.join(input.appDataRoot, 'Claude', 'claude_desktop_config.json');
  if ((input.platform ?? process.platform) !== 'win32' || !input.localAppDataRoot) return standard;

  const packagesRoot = path.join(input.localAppDataRoot, 'Packages');
  const knownPackageRoot = path.join(packagesRoot, CLAUDE_DESKTOP_MSIX_FAMILY);
  if (await exists(knownPackageRoot)) {
    return path.join(knownPackageRoot, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
  }

  try {
    const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    const claudePackages = entries
      .filter((entry) => entry.isDirectory() && /^Claude_[a-z0-9]+$/i.test(entry.name))
      .map((entry) => entry.name);
    if (claudePackages.length === 1) {
      return path.join(packagesRoot, claudePackages[0], 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
    }
  } catch {
    return standard;
  }

  return standard;
}
