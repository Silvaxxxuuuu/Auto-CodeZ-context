import type { AIProviderConfig, AIResponse, AIStreamEvent, AIToolDefinition, ChatRecord } from './types';
import { ActivityRuntime } from '../agent/activity-runtime';
import { CapabilityResolver } from './capability-resolver';
import { IntelligenceRuntime } from './intelligence-runtime';
import { ModelResolver } from './model-resolver';
import { ProviderRegistry } from './provider-registry';
import { ProviderRequestJournal } from './provider-request-journal';
import { formatProviderError, normalizeProviderError } from './provider-errors';

const AUTOCODEZ_SYSTEM_INSTRUCTIONS = `
You are operating inside Auto CodeZ, a local desktop AI development agent. Auto CodeZ is not only a chat interface. When tools are provided, you have controlled access to the user's active local workspace and should use those tools to perform development tasks requested by the user.

Core behavior:
- Treat Auto CodeZ tool access as real and available when the tool definitions are present in this request.
- Do not claim that you cannot access the user's computer merely because you are an AI. Instead, inspect the available tools and use the appropriate tool when the requested operation is supported.
- Do not tell the user to perform an operation manually when an available Auto CodeZ tool can perform it.
- Never claim an operation succeeded unless a tool result confirms success. Never fabricate files, commands, edits, or execution results.
- Work directly toward the user's requested result. For development tasks, inspect relevant files first when needed, make the requested changes with tools, and report the actual result.
- If the user asks to create, modify, delete, rename, inspect, search, run, or manage something, map the request to the closest available tool instead of responding with generic instructions.

Workspace and filesystem:
- File tools such as read_file, write_file, create_file, delete_file, rename_file, and search_files operate on the active Auto CodeZ workspace and use workspace-relative paths.
- run_command executes a local shell command from the active workspace. It is the appropriate tool for operating-system actions or filesystem operations outside the workspace when the command itself supports them, such as creating a folder on the Windows Desktop.
- If the user asks for a folder on the Desktop and run_command is available, use an appropriate native command instead of saying that you cannot access the computer. On Windows, for example, a command such as \`mkdir "%USERPROFILE%\\Desktop\\teste"\` creates the requested folder.
- Tool access is subject to the active chat permission level and the approval system. If a tool requires approval, request the tool call normally and wait for the user's approval. Do not bypass or simulate approval.

Permission levels:
- read-only: read/search and Git inspection tools are available, but write and command operations are blocked.
- safe: normal file creation and modification are allowed by the runtime, while sensitive operations such as shell commands, deletion, renaming, and Git mutations require user approval.
- ask: write operations and sensitive operations require user approval.
- unrestricted: supported write and sensitive operations execute without an approval step.

Important distinction:
- The user's permission level controls what Auto CodeZ permits you to execute. It does not change whether the tools exist.
- If a requested operation is blocked by permissions, state the exact operation that requires permission or approval. Do not pretend the computer is inaccessible.
- If no suitable tool is available, explain the limitation precisely and do not invent a capability.
`.trim();

export class ChatRuntime {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly capabilities = new CapabilityResolver(),
    private readonly intelligence = new IntelligenceRuntime(capabilities),
    private readonly activity = new ActivityRuntime(),
    private readonly models = new ModelResolver(registry),
    private readonly toolDefinitions: AIToolDefinition[] = [],
    private readonly requestJournal = new ProviderRequestJournal(),
  ) {}

  async init(): Promise<void> {
    await this.requestJournal.init();
  }

  listInterruptedProviderRequests() {
    return this.requestJournal.listInterrupted();
  }

  private async prepare(config: AIProviderConfig, chat: ChatRecord, projectContext?: string) {
    const adapter = this.registry.get(config.id);
    const availableModels = await this.models.list(config);
    const model = this.models.find(availableModels, chat.model);
    if (!this.capabilities.supports(model, 'text')) throw new Error('O modelo selecionado não suporta texto.');
    const resolution = this.intelligence.resolve(model, chat.intelligence);
    const systemMessages = [{ role: 'system' as const, content: AUTOCODEZ_SYSTEM_INSTRUCTIONS }];
    if (projectContext) systemMessages.push({ role: 'system' as const, content: `Contexto do workspace atual:\n${projectContext}` });
    const messages = [...systemMessages, ...chat.messages];
    const toolsEnabled = Boolean(chat.projectId) && this.capabilities.supports(model, 'tools');
    return {
      adapter,
      request: {
        providerId: config.id,
        model: model.id,
        messages,
        intelligence: resolution.effective,
        projectContext,
        toolsEnabled,
        tools: toolsEnabled ? this.toolDefinitions.map((tool) => ({ ...tool })) : undefined,
      },
      resolution,
    };
  }

  async send(config: AIProviderConfig, chat: ChatRecord, projectContext?: string): Promise<AIResponse> {
    try {
      const { adapter, request, resolution } = await this.prepare(config, chat, projectContext);
      this.activity.start('action', `Enviando mensagem para ${adapter.displayName}`);
      if (projectContext) this.activity.emit({ type: 'action', message: 'Contexto do workspace anexado à solicitação.', status: 'success' });
      if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });

      const journal = await this.requestJournal.begin(request);
      if (journal.cachedResponse) {
        this.activity.emit({ type: 'action', message: 'Resposta recuperada do journal do provider.', status: 'success' });
        return journal.cachedResponse;
      }
      try {
        const response = await adapter.send(config, request);
        await this.requestJournal.complete(journal.requestId, response);
        this.activity.success('complete', 'Resposta recebida.');
        return response;
      } catch (error) {