import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ComputerRuntimeFact = {
  key: string;
  value: string;
};

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

function formatFacts(facts: readonly ComputerRuntimeFact[]): string {
  return [
    'Local computer context:',
    ...facts.map((fact) => `${fact.key}: ${fact.value}`),
    'Use these resolved paths instead of asking the user for a path when the requested location is a standard local folder.',
    'For arbitrary locations outside the active workspace, use the appropriate local command and respect the chat permission/approval policy.',
  ].join('\n');
}

export class ComputerContextRuntime {
  buildFacts(): ComputerRuntimeFact[] {
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
    const facts: ComputerRuntimeFact[] = [
      { key: 'OS', value: `${process.platform} ${os.release()} (${process.arch})` },
      { key: 'User', value: os.userInfo().username },
      { key: 'Shell', value: process.env.ComSpec ?? process.env.SHELL ?? 'unknown' },
      { key: 'Drives', value: discoverDrives().join(', ') || 'unknown' },
    ];
    for (const [key, value] of paths) if (value) facts.push({ key, value });
    return facts;
  }

  build(): string {
    return formatFacts(this.buildFacts());
  }
}
