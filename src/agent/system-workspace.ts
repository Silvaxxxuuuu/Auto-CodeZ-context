import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SYSTEM_WORKSPACE_ID = '__system__';

function existingDirectory(candidates: string[]): string | undefined {
  return candidates.map((candidate) => path.resolve(candidate)).find((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

export function getSystemWorkspaceRoot(): string {
  const home = os.homedir();
  const oneDriveCandidates = [
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    process.env.OneDrive,
  ].filter((value): value is string => Boolean(value));

  const desktop = existingDirectory([
    ...oneDriveCandidates.map((root) => path.join(root, 'Desktop')),
    path.join(home, 'Desktop'),
  ]);

  if (desktop) return desktop;

  return path.resolve(path.join(home, 'Desktop'));
}
