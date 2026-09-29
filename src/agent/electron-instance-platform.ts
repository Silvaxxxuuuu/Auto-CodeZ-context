import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import type {
  InstancePlatformAdapter,
  InstancePlatformHandle,
  InstancePlatformOpenRequest,
} from './instance-runtime';

export type ManagedPreviewOpenRequest = {
  instanceId: string;
  projectId: string;
  target: string;
};

export type ElectronInstancePlatformDependencies = {
  openExternal: (url: string) => Promise<void>;
  openPath: (targetPath: string) => Promise<string>;
  openPreview: (input: ManagedPreviewOpenRequest) => Promise<InstancePlatformHandle>;
};

function uncontrolledHandle(): InstancePlatformHandle {
  return {
    canFocus: false,
    canClose: false,
  };
}

function assertHttpUrl(target: string): string {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error('URL da instância inválida.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Abertura externa aceita apenas http:// ou https://.');
  }
  return parsed.toString();
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('O target da instância está fora do workspace autorizado.');
  }
}

export class ElectronInstancePlatformAdapter implements InstancePlatformAdapter {
  constructor(
    private readonly projects: () => Promise<ProjectRecord[]>,
    private readonly dependencies: ElectronInstancePlatformDependencies,
  ) {}

  async open(input: InstancePlatformOpenRequest): Promise<InstancePlatformHandle> {
    if (input.kind === 'preview') {
      return this.dependencies.openPreview({
        instanceId: input.instanceId,
        projectId: input.projectId,
        target: assertHttpUrl(input.target),
      });
    }

    if (input.kind === 'url') {
      await this.dependencies.openExternal(assertHttpUrl(input.target));
      return uncontrolledHandle();
    }

    const target = await this.resolveWorkspaceTarget(input.projectId, input.target);
    const stat = await fs.stat(target);
    if (input.kind === 'folder' && !stat.isDirectory()) {
      throw new Error('O target solicitado não é uma pasta.');
    }
    if ((input.kind === 'file' || input.kind === 'application') && !stat.isFile()) {
      throw new Error(`O target solicitado não é um arquivo válido para '${input.kind}'.`);
    }

    const error = await this.dependencies.openPath(target);
    if (error.trim()) throw new Error(`Falha ao abrir '${target}': ${error.trim()}`);
    return uncontrolledHandle();
  }

  private async resolveWorkspaceTarget(projectId: string, requestedTarget: string): Promise<string> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado para abrir a instância.');

    const root = await fs.realpath(path.resolve(project.rootPath));
    const candidate = path.isAbsolute(requestedTarget)
      ? path.resolve(requestedTarget)
      : path.resolve(root, requestedTarget);

    let realTarget: string;
    try {
      realTarget = await fs.realpath(candidate);
    } catch {
      throw new Error(`O target '${requestedTarget}' não existe no workspace.`);
    }

    assertInside(root, realTarget);
    return realTarget;
  }
}
