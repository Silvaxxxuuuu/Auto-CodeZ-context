import type { ProjectRecord } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { CommandRuntime, SYSTEM_PROJECT_ID, type CommandResult, type CommandRunOptions } from './command-runtime';
import { CommandSandboxRuntime } from './command-sandbox';
import { currentExecutionWorkspaceContext } from './execution-workspace-context';

export class ShadowAwareCommandRuntime extends CommandRuntime {
  private readonly sandbox: CommandSandboxRuntime;

  constructor(
    private readonly projectProvider: () => Promise<ProjectRecord[]>,
    private readonly shadows: ExecutionShadowWorkspaceRuntime,
    sandbox?: CommandSandboxRuntime,
  ) {
    super(projectProvider);
    this.sandbox = sandbox ?? new CommandSandboxRuntime(projectProvider, shadows);
  }

  override async run(projectId: string, command: string, options: CommandRunOptions = {}): Promise<CommandResult> {
    const context = currentExecutionWorkspaceContext();
    if (!context || context.projectId !== projectId) return super.run(projectId, command, options);
    if (!this.shadows.get(context.chatId, context.runId)) return super.run(projectId, command, options);
    if (projectId === SYSTEM_PROJECT_ID) throw new Error('Command sandbox não executa alterações isoladas no workspace de sistema.');
    return this.sandbox.run(context.chatId, context.runId, projectId, command, options);
  }
}
