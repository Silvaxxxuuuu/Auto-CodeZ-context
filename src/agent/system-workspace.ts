import os from 'node:os';
import path from 'node:path';

export const SYSTEM_WORKSPACE_ID = '__system__';

export function getSystemWorkspaceRoot(): string {
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
  return path.resolve(oneDrive ? path.join(oneDrive, 'Desktop') : path.join(os.homedir(), 'Desktop'));
}
