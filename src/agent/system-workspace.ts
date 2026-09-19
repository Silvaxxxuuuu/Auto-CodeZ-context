import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SYSTEM_WORKSPACE_ID = '__system__';

export function getSystemWorkspaceRoot(): string {
  const home = path.resolve(os.homedir());
  try {
    if (fs.statSync(home).isDirectory()) return home;
  } catch {
    // Fall through to the normalized home path so callers still get a stable root.
  }
  return home;
}
