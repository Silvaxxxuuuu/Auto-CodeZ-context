import type { ProjectRecord } from '../ai/types';
import { ProjectManager } from '../core/project-manager';

export class ProjectContextRuntime {
  constructor(private readonly projects: ProjectManager, private readonly maxEntries = 300) {}

  async build(projectId: string): Promise<string> {
    const project = await this.getProject(projectId);
    const entries = await this.projects.scan(project.rootPath);
    const files = entries.filter((entry) => entry.type === 'file').slice(0, this.maxEntries);
    const directories = entries.filter((entry) => entry.type === 'directory').slice(0, this.maxEntries);
    const lines = [
      `Workspace: ${project.name}`,
      `Root: ${project.rootPath}`,
      `Directories: ${directories.length}`,
      `Files: ${files.length}`,
      '',
      'Workspace tree:',
      ...entries.slice(0, this.maxEntries).map((entry) => `${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.relativePath}`),
    ];
    if (entries.length > this.maxEntries) lines.push(`... ${entries.length - this.maxEntries} entries omitted.`);
    return lines.join('\n');
  }

  private async getProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects.list()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }
}
