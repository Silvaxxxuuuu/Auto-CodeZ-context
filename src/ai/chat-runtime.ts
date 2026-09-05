import type { AIModel, AIProviderConfig, AIResponse, AIStreamEvent, AIToolDefinition, ChatRecord } from './types';
import { ActivityRuntime } from '../agent/activity-runtime';
import { CapabilityResolver } from './capability-resolver';
import { IntelligenceRuntime } from './intelligence-runtime';
import { ModelResolver } from './model-resolver';
import { ProviderRegistry } from './provider-registry';
import { isExplicitProviderRecovery } from './provider-recovery-context';
import { fingerprintProviderScope, ProviderRequestJournal } from './provider-request-journal';
import { formatProviderError, normalizeProviderError } from './provider-errors';
import { SYSTEM_PROJECT_ID } from '../agent/command-runtime';
import { runWithAbortSignal } from './request-cancellation';

const AUTOCODEZ_SYSTEM_INSTRUCTIONS = `
You are operating inside Auto CodeZ, a local desktop AI development agent. Auto CodeZ is not only a chat interface. When tools are provided, you have controlled access to the user's active local workspace and should use those tools to perform development tasks requested by the user.

Core behavior:
- Treat Auto CodeZ tool access as real and available when the tool definitions are present in this request.
- Do not claim that you cannot access the user's computer merely because you are an AI. Instead, inspect the available tools and use the appropriate tool when the requested operation is supported.
- Do not tell the user to perform an operation manually when an available Auto CodeZ tool can perform it.
- Never claim an operation succeeded unless a tool result confirms success. Never fabricate files, commands, edits, or execution results.
- Work directly toward the user's requested result. For development tasks, inspect relevant files first when needed, make the requested changes with tools, and report the actual result.
- If the user asks to create, modify, delete, rename, inspect, search, run, or manage something, map the request to the closest available tool instead of responding with generic instructions.
- When the user gives a direct, actionable request that is supported by an available tool, issue the tool call immediately. Do not ask for information that Auto CodeZ already knows from its runtime context.
- Never simulate a tool call, approval request, execution, or completion in natural-language text. Only actual tool calls and runtime events represent those states.
- Never say that you are about to create, edit, run, inspect, search, or otherwise perform an action unless the same response actually contains the required tool call(s).
- For multi-step requests, continue using tools until every requested step that can be performed with available tools is actually complete. Do not stop after the first successful operation merely to describe the remaining work.
- Auto CodeZ supports multiple tool calls in one user request, but approval-dependent operations are materialized sequentially by the runtime. If a later operation is reported as deferred because an earlier one still awaits approval, wait for that result and issue the still-needed operation again in the next tool round.
- After an approval is granted and its tool result is returned, immediately continue the remaining requested work. A successful first tool result is not a final answer if the user's original task still contains unfinished actions.
- A shell command that exits successfully is evidence only that the shell accepted and completed the command. It is not sufficient proof that an intended file or directory now exists in the requested location.
- When run_command is used to create, move, rename, copy, delete, or modify filesystem content that cannot be represented by a file tool, verify the resulting filesystem state with a subsequent tool call before claiming completion. On Windows, prefer explicit checks such as if exist, dir, or PowerShell Test-Path/Get-Item/Get-Content as appropriate.
- For file creation tasks performed through run_command, verify every requested file or directory that matters to the user's result. If verification fails, continue fixing the operation instead of giving a completion message.
- If a command result reports a non-zero exit code, timeout, or failure, treat the operation as failed and do not claim success.

Live activity summaries:
- Whenever your response contains one or more tool calls, the natural-language content of that response is not a user-facing answer. It is a short, dynamically generated live activity summary for the Auto CodeZ interface.
- Generate that activity summary from the exact action you are taking now and the current context. Do not use a fixed generic label.
- Keep it concise: normally one short sentence or phrase, in the user's language, with no markdown, no code block, and no long explanation.
- Do not include file contents, planned future steps, or a completion claim in an activity summary.
- Examples only illustrate the style and must not be copied mechanically: a repository lookup could become "Conferindo a implementação atual do provider"; a web action could become "Pesquisando a documentação do Vite"; a file operation could become "Montando os arquivos da página inicial".
- The final natural-language answer is only produced after all requested tool work is complete or after a real limitation/error prevents further progress.

Workspace and filesystem:
- Contexto do workspace atual: when project context is supplied with this request, treat it as authoritative context for the active workspace.
- File tools such as read_file, read_symbol, write_file, create_file, replace_range, replace_text, replace_symbol, insert_before, insert_after, delete_file, rename_file, and search_files operate on the active Auto CodeZ workspace and use workspace-relative paths.
- Inside an Auto CodeZ project workspace, use file tools for direct file mutations whenever they can represent the requested operation. When you only need one complete named TypeScript or JavaScript declaration, prefer read_symbol over read_file when its supported syntax kind is known. For replacing a complete named TypeScript or JavaScript declaration, prefer replace_symbol. For smaller localized edits, prefer replace_text when you have an exact unique fragment from a recent read; otherwise use replace_range, insert_before or insert_after instead of rewriting the whole file with write_file. Use write_file when most or all of a file genuinely needs replacement. Do not substitute shell redirection, PowerShell file-writing commands or similar run_command filesystem edits for these file tools. This preserves smaller diffs, diff review, stale-file protection, approval ownership and recoverability.
- In a normal chat, file tools operate inside a protected system workspace rooted at the user's Home directory. Use workspace-relative paths such as Desktop/Novo site/index.html, Documents/example.txt or Downloads/data.csv. These tools cannot escape the protected Home workspace.
- In a normal chat, prefer create_file/write_file/replace_range/replace_text/replace_symbol/insert_before/insert_after/delete_file/rename_file over run_command for direct file mutations. For localized edits, prefer the incremental tools instead of replacing the whole file. create_file automatically creates missing parent directories, so creating Desktop/Novo site/index.html also creates the required folder path safely.
- Use run_command for tests, builds, package managers, scripts, CLIs, empty-directory creation and operations that genuinely require a shell.
- run_command executes a local shell command. In a project chat it runs from the active workspace; in a normal chat it runs from the protected system workspace and can perform supported operating-system actions subject to permission and approval policy.
- If the user asks for a standard local folder such as Desktop, use the resolved runtime path/context instead of asking which OS or path they use.
- Tool access is subject to the active chat permission level and the approval system. If a tool requires approval, request the tool call normally and wait for the user's approval. Do not bypass or simulate approval.

Permission levels:
- read-only: read/search and Git inspection tools are available, but write and command operations are blocked.
- safe: normal project file creation and modification are allowed by the runtime, while sensitive operations such as shell commands, deletion, renaming, Git mutations, and file mutations in the protected system workspace require user approval.
- ask: write operations and sensitive operations require user approval.
- unrestricted: supported write and sensitive operations execute without an approval step.

Important distinction:
- The user's permission level controls what Auto CodeZ permits you to execute. It does not change whether the tools exist.
- If a requested operation is blocked by permissions, state the exact operation that requires permission or approval. Do not pretend the computer is inaccessible.
- If no suitable tool is available, explain the limitation precisely and do not invent a capability.
`.trim();

const SYSTEM_CHAT_TOOL_NAMES = new Set(['read_file', 'read_symbol', 'write_file', 'create_file', 'replace_range', 'replace_text', 'replace_symbol', 'insert_before', 'insert_after', 'delete_file', 'rename_file', 'search_files', 'run_command']);

function runtimePlatform(): string {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function nextWithAbortSignal<T>(signal: AbortSignal | undefined, next: () => Promise<IteratorResult<T>>): Promise<IteratorResult<T>> {
  if (!signal) return next();
  signal.throwIfAborted();
  return runWithAbortSignal(signal, next);
}

function activityEventForResponse(response: AIResponse): AIStreamEvent | undefined {
  if (!response.toolCalls?.length) return undefined;
  const message = response.content.trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!message) return undefined;
  const firstTool = response.toolCalls[0];
  return {
    type: 'activity',
    activity: {
      type: 'thought',
      message,
      status: 'running',
      toolCallId: firstTool.id,
      toolName: firstTool.name,
    },
  };
}

function responseForAgent(response: AIResponse): AIResponse {
  if (!response.toolCalls?.length || !response.content) return response;
  return { ...response, content: '' };
}

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

  private async prepare(config: AIProviderConfig, chat: ChatRecord, projectContext?: string, signal?: AbortSignal) {
    const adapter = this.registry.get(config.id);
    let model: AIModel;
    try {
      signal?.throwIfAborted();
      const availableModels = await runWithAbortSignal(signal, () => this.models.list(config));
      signal?.throwIfAborted();
      model = this.models.find(availableModels, chat.model, config.id);
    } catch (error) {
      if (isAbortError(error)) throw error;
      model = this.models.fallbackForConfiguredModel(config, chat.model);
      this.activity.emit({ type: 'action', message: `${adapter.displayName}: descoberta de modelos indisponível; usando o modelo já configurado (${model.id}).`, status: 'pending' });
    }
    if (!this.capabilities.supports(model, 'text')) throw new Error('O modelo selecionado não suporta texto.');
    const resolution = this.intelligence.resolve(model, chat.intelligence);
    const systemMessages = [{ role: 'system' as const, content: `${AUTOCODEZ_SYSTEM_INSTRUCTIONS}\n\nRuntime OS: ${runtimePlatform()}.` }];
    if (projectContext) systemMessages.push({ role: 'system' as const, content: `Contexto do workspace atual:\n${projectContext}` });
    const messages = [...systemMessages, ...chat.messages];
    const hasProject = Boolean(chat.projectId) && chat.projectId !== SYSTEM_PROJECT_ID;
    if (!chat.projectId) chat.projectId = SYSTEM_PROJECT_ID;
    const tools = hasProject ? this.toolDefinitions : this.toolDefinitions.filter((tool) => SYSTEM_CHAT_TOOL_NAMES.has(tool.name));
    const toolsEnabled = this.capabilities.supports(model, 'tools') && tools.length > 0;
    return { adapter, request: { providerId: config.id, model: model.id, messages, intelligence: resolution.effective, projectContext, toolsEnabled, tools: toolsEnabled ? tools.map((tool) => ({ ...tool })) : undefined }, resolution };
  }

  private beginProviderRequest(config: AIProviderConfig, request: Parameters<ProviderRequestJournal['begin']>[0]) {
    return this.requestJournal.begin(request, fingerprintProviderScope(config), { allowInterruptedRetry: isExplicitProviderRecovery() });
  }

  async send(config: AIProviderConfig, chat: ChatRecord, projectContext?: string, signal?: AbortSignal): Promise<AIResponse> {
    try {
      signal?.throwIfAborted();
      const { adapter, request, resolution } = await this.prepare(config, chat, projectContext, signal);
      this.activity.start('action', `Enviando mensagem para ${adapter.displayName}`);
      if (projectContext) this.activity.emit({ type: 'action', message: 'Contexto do workspace anexado à solicitação.', status: 'success' });
      if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });
      const journal = await this.beginProviderRequest(config, request);
      if (journal.cachedResponse) {
        const cachedActivity = activityEventForResponse(journal.cachedResponse);
        if (cachedActivity?.activity) this.activity.emit(cachedActivity.activity);
        return responseForAgent(journal.cachedResponse);
      }
      try {
        const response = await runWithAbortSignal(signal, () => adapter.send(config, request, signal));
        await this.requestJournal.complete(journal.requestId, response);
        const dynamicActivity = activityEventForResponse(response);
        if (dynamicActivity?.activity) this.activity.emit(dynamicActivity.activity);
        this.activity.success('complete', 'Resposta recebida.');
        return responseForAgent(response);
      } catch (error) {
        if (isAbortError(error)) {
          await this.requestJournal.fail(journal.requestId, 'Solicitação cancelada pelo usuário.');
          throw error;
        }
        const normalized = normalizeProviderError(adapter.displayName, 'request', error);
        await this.requestJournal.fail(journal.requestId, normalized.message);
        throw normalized;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      const normalized = normalizeProviderError(config.displayName, 'request', error);
      const message = formatProviderError(normalized);
      this.activity.failure('error', message);
      throw new Error(message);
    }
  }

  async *stream(config: AIProviderConfig, chat: ChatRecord, projectContext?: string, signal?: AbortSignal): AsyncGenerator<AIStreamEvent> {
    try {
      signal?.throwIfAborted();
      const { adapter, request, resolution } = await this.prepare(config, chat, projectContext, signal);
      this.activity.start('action', `Transmitindo resposta de ${adapter.displayName}`);
      if (projectContext) this.activity.emit({ type: 'action', message: 'Contexto do workspace anexado à solicitação.', status: 'success' });
      if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });
      const journal = await this.beginProviderRequest(config, request);
      if (journal.cachedResponse) {
        yield { type: 'start' };
        const cachedActivity = activityEventForResponse(journal.cachedResponse);
        if (cachedActivity) yield cachedActivity;
        if (journal.cachedResponse.content) yield { type: 'delta', text: journal.cachedResponse.content };
        const cachedResponse = responseForAgent(journal.cachedResponse);
        yield { type: 'complete', response: cachedResponse, usage: cachedResponse.usage };
        return;
      }
      let completed = false;
      try {
        if (adapter.stream) {
          const iterator = adapter.stream(config, request, signal)[Symbol.asyncIterator]();
          while (true) {
            const result = await nextWithAbortSignal(signal, () => iterator.next());
            if (result.done) break;
            const event = result.value;
            if (event.type === 'activity' && event.activity) this.activity.emit(event.activity);
            if (event.type === 'complete' && event.response) {
              const originalResponse = event.response;
              const dynamicActivity = activityEventForResponse(originalResponse);
              if (dynamicActivity?.activity) {
                this.activity.emit(dynamicActivity.activity);
                yield dynamicActivity;
              }
              await this.requestJournal.complete(journal.requestId, originalResponse);
              completed = true;
              const sanitizedResponse = responseForAgent(originalResponse);
              yield { ...event, response: sanitizedResponse };
              continue;
            }
            if (event.type === 'error' && !completed) await this.requestJournal.fail(journal.requestId, event.error || 'Erro durante o streaming.');
            yield event;
          }
        } else {
          const response = await runWithAbortSignal(signal, () => adapter.send(config, request, signal));
          await this.requestJournal.complete(journal.requestId, response);
          completed = true;
          yield { type: 'start' };
          const dynamicActivity = activityEventForResponse(response);
          if (dynamicActivity?.activity) {
            this.activity.emit(dynamicActivity.activity);
            yield dynamicActivity;
          }
          if (response.content) yield { type: 'delta', text: response.content };
          const sanitizedResponse = responseForAgent(response);
          yield { type: 'complete', response: sanitizedResponse, usage: sanitizedResponse.usage };
        }
        this.activity.success('complete', 'Resposta recebida.');
      } catch (error) {
        if (isAbortError(error)) {
          if (!completed) await this.requestJournal.fail(journal.requestId, 'Solicitação cancelada pelo usuário.');
          throw error;
        }
        if (!completed) { const normalized = normalizeProviderError(adapter.displayName, 'stream', error); await this.requestJournal.fail(journal.requestId, normalized.message); throw normalized; }
        throw error;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      const normalized = normalizeProviderError(config.displayName, 'stream', error);
      const message = formatProviderError(normalized);
      this.activity.failure('error', message);
      yield { type: 'error', error: message };
    }
  }
}