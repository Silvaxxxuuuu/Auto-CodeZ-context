import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function existingDirectory(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = path.resolve(value);
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function firstExisting(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const existing = existingDirectory(value);
    if (existing) return existing;
  }
  return undefined;
}

function discoverDrives(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) drives.push(root);
    } catch {
      // Drive is unavailable or not mounted.
    }
  }
  return drives;
}

export class ComputerContextRuntime {
  build(): string {
    const home = os.homedir();
    const oneDrive = firstExisting([
      process.env.OneDriveConsumer,
      process.env.OneDriveCommercial,
      process.env.OneDrive,
    ]);
    const paths: Array<[string, string | undefined]> = [
      ['Home', home],
      ['Desktop', firstExisting([oneDrive && path.join(oneDrive, 'Desktop'), path.join(home, 'Desktop')])],
      ['Documents', firstExisting([oneDrive && path.join(oneDrive, 'Documents'), path.join(home, 'Documents')])],
      ['Downloads', firstExisting([path.join(home, 'Downloads')])],
      ['Pictures', firstExisting([oneDrive && path.join(oneDrive, 'Pictures'), path.join(home, 'Pictures')])],
      ['Music', firstExisting([oneDrive && path.join(oneDrive, 'Music'), path.join(home, 'Music')])],
      ['Videos', firstExisting([oneDrive && path.join(oneDrive, 'Videos'), path.join(home, 'Videos')])],
      ['OneDrive', oneDrive],
      ['AppData', existingDirectory(process.env.APPDATA)],
      ['LocalAppData', existingDirectory(process.env.LOCALAPPDATA)],
      ['ProgramFiles', existingDirectory(process.env.ProgramFiles)],
      ['ProgramFilesX86', existingDirectory(process.env['ProgramFiles(x86)'])],
      ['Temp', existingDirectory(os.tmpdir())],
      ['ApplicationDirectory', existingDirectory(process.cwd())],
    ];
    const lines = [
      'Local computer context:',
      `OS: ${process.platform} ${os.release()} (${process.arch})`,
      `User: ${os.userInfo().username}`,
      `Shell: ${process.env.ComSpec ?? process.env.SHELL ?? 'unknown'}`,
      `Drives: ${discoverDrives().join(', ') || 'unknown'}`,
    ];
    for (const [label, value] of paths) if (value) lines.push(`${label}: ${value}`);
    lines.push('Use these resolved paths instead of asking the user for a path when the requested location is a standard local folder.');
    lines.push('For arbitrary locations outside the active workspace, use the appropriate local command and respect the chat permission/approval policy.');
    return lines.join('\n');
  }
}
