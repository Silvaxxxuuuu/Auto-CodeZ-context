import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ProjectRecord } from '../ai/types';

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SAFE_SCRIPTS = new Set(['test', 'build', 'typecheck', 'lint', 'package', 'check']);
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

export class CommandRuntime {
  constructor(private readonly projects: () => Promise<ProjectRecord[]>) {}

  private async project(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  async run(projectId: string, manager: string, script: string): Promise<CommandResult> {
    if (!MANAGERS.has(manager)) throw new Error('Gerenciador de pacotes não permitido.');
    if (!SAFE_SCRIPTS.has(script)) throw new Error('Script não permitido pelo runtime.');

    const project = await this.project(projectId);
    const cwd = await fs.realpath(path.resolve(project.rootPath));
    const packagePath = path.join(cwd, 'package.json');
    const packageData = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { scripts?: Record<string, string> };
    if (!packageData.scripts?.[script]) throw new Error(`O script '${script}' não existe no projeto.`);

    const executable = process.platform === 'win32' ? `${manager}.cmd` : manager;
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['run', script], {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, CI: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ command: `${manager} run ${script}`, exitCode: exitCode ?? 1, stdout, stderr }));
    });
  }
}
