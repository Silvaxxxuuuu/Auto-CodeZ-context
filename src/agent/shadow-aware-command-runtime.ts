import type { ProjectRecord } from '../ai/types';
import type { ExecutionShadowWorkspaceRuntime } from '../execution-shadow-workspace';
import { CommandRuntime, type CommandResult, type CommandRunOptions } from './command-runtime';
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
    if (!context) return super.run(projectId, command, options);
    if (context.projectId !== projectId) throw new Error('Contexto de execução pertence a outro projeto.');

    this.shadows.begin(context.chatId, context.runId, projectId);
    return this.sandbox.run(context.chatId, context.runId, projectId, command, options);
  }
}
