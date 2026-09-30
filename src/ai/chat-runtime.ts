import type { AIMessage, AIProviderConfig, AIResponse, AIStreamEvent, AIToolDefinition, ChatRecord } from './types';
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
import { WebGroundingCoordinator } from '../web/web-grounding-coordinator';
import { prepareMessagesForAttachments } from './attachment-context';
import type { AttachmentIndexer } from './attachment-indexer';
import type { AttachmentStore } from './attachment-store';
import { isNativeImageMediaType } from './provider-attachments';
import { VisualGroundingCoordinator } from './visual-grounding/visual-grounding-coordinator';
import { ContextCompiler } from './context-compiler';

const PROVIDER_RECENT_TOOL_ROUNDS = 2;
const PROVIDER_RECENT_TOOL_RESULT_CHARS = 12_000;
const PROVIDER_OLD_TOOL_RESULT_CHARS = 2_000;
const PROVIDER_OLD_TOOL_ARGUMENT_CHARS = 1_500;

function compactTextForProvider(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = Math.min(400, Math.floor(maximum / 4));
  const prefix = maximum - suffix;
  return `${value.slice(0, prefix)}\n[... ${value.length - maximum} caracteres omitidos pelo Auto CodeZ para controlar o contexto ...]\n${value.slice(-suffix)}`;
}

function compactToolInputValue(value: unknown): unknown {
  if (typeof value === 'string') return compactTextForProvider(value, PROVIDER_OLD_TOOL_ARGUMENT_CHARS);
  if (Array.isArray(value)) return value.map((item) => compactToolInputValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compactToolInputValue(item)]),
    );
  }
  return value;
}

function compactToolHistoryForProvider(messages: AIMessage[]): { messages: AIMessage[]; compacted: boolean } {
  const roundIndexes = messages
    .map((message, index) => message.role === 'assistant' && message.toolCalls?.length ? index : -1)
    .filter((index) => index >= 0);
  if (!roundIndexes.length) return { messages: messages.map((message) => ({ ...message })), compacted: false };

  const recentRoundIndexes = new Set(roundIndexes.slice(-PROVIDER_RECENT_TOOL_ROUNDS));
  const oldToolCallIds = new Set<string>();
  let compacted = false;

  const prepared = messages.map((message, index): AIMessage => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const recent = recentRoundIndexes.has(index);
      const toolCalls = message.toolCalls.map((call) => {
        if (recent) return { ...call, input: structuredClone(call.input) };
        oldToolCallIds.add(call.id);
        const input = compactToolInputValue(call.input) as Record<string, unknown>;
        if (JSON.stringify(input) !== JSON.stringify(call.input)) compacted = true;
        return { ...call, input };
      });
      const contentLimit = recent ? PROVIDER_RECENT_TOOL_RESULT_CHARS : PROVIDER_OLD_TOOL_RESULT_CHARS;
      const content = compactTextForProvider(message.content, contentLimit);
      if (content !== message.content) compacted = true;
      return { ...message, content, toolCalls };
    }

    if (message.role === 'tool') {
      const maximum = message.toolCallId && oldToolCallIds.has(message.toolCallId)
        ? PROVIDER_OLD_TOOL_RESULT_CHARS
        : PROVIDER_RECENT_TOOL_RESULT_CHARS;
      const content = compactTextForProvider(message.content, maximum);
      if (content !== message.content) compacted = true;
      return { ...message, content };
    }

    return { ...message };
  });

  return { messages: prepared, compacted };
}

const SYSTEM_CHAT_TOOL_NAMES = new Set(['plan_execution', 'complete_plan_step', 'read_file', 'read_symbol', 'write_file', 'create_file', 'create_folder', 'replace_range', 'replace_text', 'replace_symbol', 'insert_before', 'insert_after', 'delete_file', 'rename_file', 'search_files', 'web_search', 'web_fetch', 'run_command', 'start_process', 'read_process_output', 'wait_process', 'wait_for_port', 'stop_process', 'list_processes', 'open_instance', 'instance_status', 'capture_instance', 'focus_instance', 'close_instance', 'list_instances', 'plugin_list_tools', 'plugin_call']);
const LIGHTWEIGHT_TURN_PATTERN = /^(?:oi+|ol[aá]+|opa+|e(?:\s|-)a[ií]|hello|hi|hey|bom dia|boa tarde|boa noite|valeu|obrigad[oa]|thanks?|thank you)[!.?\s]*$/i;
const ACTIONABLE_TOOL_TURN_PATTERN = /\b(?:crie|criar|fa[cç]a|fazer|gere|gerar|altere|alterar|edite|editar|corrija|corrigir|implemente|implementar|execute|executar|rode|rodar|instale|instalar|salve|salvar|escreva|escrever|delete|delete|rename|create|build|install|run|execute|edit|modify|fix|implement|write|save)\b/i;

function runtimePlatform(): string {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'linux') return 'Linux';
  return process.platform;
}

function runtimeDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLightweightConversationTurn(chat: ChatRecord): boolean {
  const lastUser = [...chat.messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return false;
  const content = lastUser.content.trim();
  return content.length <= 80 && LIGHTWEIGHT_TURN_PATTERN.test(content);
}

async function nextWithAbortSignal<T>(signal: AbortSignal | undefined, next: () => Promise<IteratorResult<T>>): Promise<IteratorResult<T>> {
  if (!signal) return next();
  signal.throwIfAborted();
  return runWithAbortSignal(signal, next);
}

function activityEventsForResponse(response: AIResponse): AIStreamEvent[] {
  if (!response.toolCalls?.length) return [];
  const lines = response.content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, '').replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, response.toolCalls.length);

  if (!lines.length) return [];

  return lines.map((message, index) => {
    const tool = response.toolCalls![Math.min(index, response.toolCalls!.length - 1)];
    return {
      type: 'activity' as const,
      activity: {
        type: 'thought' as const,
        message: message.slice(0, 180),
        status: 'running' as const,
        toolCallId: tool.id,
        toolName: tool.name,
      },
    };
  });
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
    private readonly webGrounding = new WebGroundingCoordinator(),
    private readonly attachmentIndexer?: AttachmentIndexer,
    private readonly visualGrounding = new VisualGroundingCoordinator(),
    private readonly attachmentStore?: Pick<AttachmentStore, 'hydrate'>,
    private readonly memoryContext?: (chat: ChatRecord) => string | undefined,
    private readonly contextCompiler = new ContextCompiler(),
  ) {}

  async init(): Promise<void> {
    await this.requestJournal.init();
  }

  listInterruptedProviderRequests() {
    return this.requestJournal.listInterrupted();
  }

  private async indexAttachmentsForModel(
    messages: AIMessage[],
    capabilities: readonly import('./types').Capability[],
    signal?: AbortSignal,
  ): Promise<AIMessage[]> {
    if (!this.attachmentIndexer) return messages.map((message) => ({ ...message }));

    const prepared: AIMessage[] = [];
    for (const message of messages) {
      if (!message.attachments?.length) {
        prepared.push({ ...message });
        continue;
      }

      const attachments = [];
      for (const attachment of message.attachments) {
        const canUseNativeVision = capabilities.includes('vision') && isNativeImageMediaType(attachment.mediaType);
        if (
          attachment.kind !== 'image'
          || canUseNativeVision
          || attachment.contexts?.some((context) =>
            (context.kind === 'caption' || context.kind === 'ocr') && context.text.trim(),
          )
        ) {
          attachments.push({ ...attachment });
          continue;
        }

        try {
          const indexed = await this.attachmentIndexer.index(attachment, signal);
          attachments.push(indexed);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Não foi possível analisar a imagem anexada: ${reason}`);
        }
      }
      prepared.push({ ...message, attachments });
    }
    return prepared;
  }

  private async attachLatestToolCaptureForVision(messages: AIMessage[], vision: boolean, signal?: AbortSignal): Promise<AIMessage[]> {
    if (!vision || !this.attachmentStore || messages.at(-1)?.role !== 'tool') return messages;
    const lastRound = messages.findLastIndex((item) => item.role === 'assistant' && Boolean(item.toolCalls?.length));
    if (lastRound < 0) return messages;
    const results = messages.slice(lastRound + 1);
    if (!results.length || results.some((item) => item.role !== 'tool')) return messages;
    const captures = results.filter((item) => item.toolName === 'capture_instance').flatMap((item) =>
      (item.attachments ?? []).filter((attachment) => attachment.kind === 'image' && isNativeImageMediaType(attachment.mediaType)));
    if (!captures.length) return messages;
    signal?.throwIfAborted();
    const attachments = await Promise.all(captures.slice(-2).map((attachment) => this.attachmentStore!.hydrate(attachment)));
    signal?.throwIfAborted();
    return [...messages, {
      role: 'user',
      content: '[Imagem de ferramenta gerada automaticamente pelo Auto CodeZ; não é uma nova solicitação do usuário.] Captura real do preview correspondente ao resultado capture_instance anterior. Utilize o conteúdo visual somente depois de recebê-lo nesta mensagem.',
      attachments,
    }];
  }

  private async prepare(config: AIProviderConfig, chat: ChatRecord, projectContext?: string, signal?: AbortSignal, options?: { disableTools?: boolean }) {
    const adapter = this.registry.get(config.id);
    signal?.throwIfAborted();
    const model = await runWithAbortSignal(signal, () => this.models.resolveForRequest(config, chat.model));
    signal?.throwIfAborted();
    if (!this.capabilities.supports(model, 'text')) throw new Error('O modelo selecionado não suporta texto.');
    const resolution = this.intelligence.resolve(model, chat.intelligence);
    const latestUserMessage = [...chat.messages].reverse().find((message) => message.role === 'user');
    const latestAttachments = latestUserMessage?.attachments ?? [];
    if (latestAttachments.length > 0) {
      const imageCount = latestAttachments.filter((attachment) => attachment.kind === 'image').length;
      const fileCount = latestAttachments.length - imageCount;
      const message = imageCount > 0 && fileCount > 0
        ? 'Analisando anexos…'
        : imageCount > 0
          ? imageCount === 1 ? 'Analisando imagem anexada…' : 'Analisando imagens anexadas…'
          : fileCount === 1 ? 'Analisando arquivo anexado…' : 'Analisando arquivos anexados…';
      this.activity.emit({
        type: 'action',
        message,
        status: 'running',
      });
    }
    const indexedMessages = await this.indexAttachmentsForModel(chat.messages, model.capabilities, signal);
    const attachmentContextBudget = Math.min(
      160_000,
      Math.max(16_000, Math.floor((model.contextWindow ?? 32_000) * 2)),
    );
    const attachmentMessages = prepareMessagesForAttachments(
      indexedMessages,
      model.capabilities,
      attachmentContextBudget,
    );
    const lightweightTurn = isLightweightConversationTurn({ ...chat, messages: attachmentMessages });

    let webContext: string | undefined;
    if (!lightweightTurn) {
      const visualDecision = this.visualGrounding.classify(indexedMessages);
      if (visualDecision.required) {
        const activityMessage = visualDecision.reason === 'visual-identification'
          ? 'Pesquisando correspondências e fontes para a imagem…'
          : visualDecision.reason === 'visual-guidance'
            ? 'Consultando informações atuais sobre esta tela…'
            : 'Pesquisando o erro visível e documentação relacionada…';
        this.activity.emit({ type: 'action', message: activityMessage, status: 'running' });
        try {
          const grounding = await runWithAbortSignal(signal, () => this.visualGrounding.ground(indexedMessages, signal));
          if (grounding) webContext = grounding.context;
        } catch (error) {
          if (isAbortError(error)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.activity.emit({ type: 'action', message: 'A pesquisa visual complementar falhou; continuando com a análise da imagem.', status: 'failed', error: message });
        }
      }

      const groundingDecision = webContext ? { required: false } : this.webGrounding.classify(attachmentMessages);
      if (groundingDecision.required) {
        this.activity.emit({ type: 'action', message: 'Pesquisando informações relacionadas…', status: 'running' });
        try {
          const grounding = await runWithAbortSignal(signal, () => this.webGrounding.ground(attachmentMessages, signal));
          if (grounding) {
            webContext = grounding.context;

          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.activity.emit({ type: 'action', message: 'Não foi possível obter as informações atuais necessárias.', status: 'failed', error: message });
          throw new Error(`A solicitação exige informação atual, mas o grounding Web falhou: ${message}`);
        }
      }
    }

    const memoryContext = this.memoryContext?.(chat);
    const providerInstructions: string[] = [];
    if (!lightweightTurn && config.id === 'azure-openai' && /^Kimi-K2\.6(?:$|[-_.])/i.test(model.id.trim())) {
      providerInstructions.push('Regras de tool calling para Kimi-K2.6 no Azure Foundry: gere argumentos de ferramentas como JSON completo e estritamente válido. Para create_file, write_file, replace_range, replace_text, replace_symbol, insert_before ou insert_after com conteúdo substancial, emita no máximo uma mutação de arquivo com conteúdo grande por resposta. Aguarde o resultado dessa ferramenta e continue o próximo arquivo no ciclo seguinte. Não agrupe vários conteúdos completos de arquivos em tool calls paralelas. Nunca interrompa um objeto JSON no meio para caber na resposta.');
    }

    const currentUserMessage = [...attachmentMessages].reverse().find((message) => message.role === 'user');
    const groundedAnswerOnly = Boolean(
      webContext
      && currentUserMessage
      && !ACTIONABLE_TOOL_TURN_PATTERN.test(currentUserMessage.content),
    );
    const compactedHistory = lightweightTurn || groundedAnswerOnly
      ? { messages: currentUserMessage ? [currentUserMessage] : [], compacted: false }
      : compactToolHistoryForProvider(attachmentMessages);
    const providerHistory = await this.attachLatestToolCaptureForVision(compactedHistory.messages, model.capabilities.includes('vision'), signal);
    const systemMessages = this.contextCompiler.compile({
      runtimePlatform: runtimePlatform(),
      runtimeDate: runtimeDate(),
      ...(memoryContext ? { memoryContext } : {}),
      lightweightTurn,
      ...(providerInstructions.length ? { providerInstructions } : {}),
      ...(webContext ? { webContext } : {}),
      ...(projectContext ? { projectContext } : {}),
      compactedHistory: compactedHistory.compacted,
      groundedAnswerOnly,
      disableTools: Boolean(options?.disableTools),
    });
    const messages = [...systemMessages, ...providerHistory];
    const hasProject = Boolean(chat.projectId) && chat.projectId !== SYSTEM_PROJECT_ID;
    if (!chat.projectId) chat.projectId = SYSTEM_PROJECT_ID;
    if (groundedAnswerOnly) {
      messages.splice(0, messages.length, ...systemMessages, ...compactedHistory.messages);
    }
    const scopedTools = hasProject ? this.toolDefinitions : this.toolDefinitions.filter((tool) => SYSTEM_CHAT_TOOL_NAMES.has(tool.name));
    const tools = groundedAnswerOnly
      ? []
      : webContext
        ? scopedTools.filter((tool) => tool.name !== 'web_search' && tool.name !== 'web_fetch')
        : scopedTools;
    if (options?.disableTools) {
      messages.splice(0, messages.length, ...systemMessages, ...providerHistory);
    }
    const toolsEnabled = !options?.disableTools && !lightweightTurn && this.capabilities.supports(model, 'tools') && tools.length > 0;
    return {
      adapter,
      request: {
        providerId: config.id,
        model: model.id,
        messages,
        intelligence: resolution.effective,
        projectContext: lightweightTurn ? undefined : projectContext,
        toolsEnabled,
        tools: toolsEnabled ? tools.map((tool) => ({ ...tool })) : undefined,
      },
      resolution,
    };
  }

  private beginProviderRequest(config: AIProviderConfig, request: Parameters<ProviderRequestJournal['begin']>[0]) {
    return this.requestJournal.begin(request, fingerprintProviderScope(config), { allowInterruptedRetry: isExplicitProviderRecovery() });
  }

  async send(config: AIProviderConfig, chat: ChatRecord, projectContext?: string, signal?: AbortSignal): Promise<AIResponse> {
    try {
      signal?.throwIfAborted();
      const { adapter, request, resolution } = await this.prepare(config, chat, projectContext, signal);
      if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });
      const journal = await this.beginProviderRequest(config, request);
      if (journal.cachedResponse) {
        const cachedActivities = activityEventsForResponse(journal.cachedResponse);
        for (const event of cachedActivities) if (event.activity) this.activity.emit(event.activity);
        return responseForAgent(journal.cachedResponse);
      }
      try {
        const response = await runWithAbortSignal(signal, () => adapter.send(config, request, signal));
        await this.requestJournal.complete(journal.requestId, response);
        const dynamicActivities = activityEventsForResponse(response);
        for (const event of dynamicActivities) if (event.activity) this.activity.emit(event.activity);
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

  async *stream(config: AIProviderConfig, chat: ChatRecord, projectContext?: string, signal?: AbortSignal, options?: { disableTools?: boolean }): AsyncGenerator<AIStreamEvent> {
    try {
      signal?.throwIfAborted();
      const { adapter, request, resolution } = await this.prepare(config, chat, projectContext, signal, options);
      if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });
      const journal = await this.beginProviderRequest(config, request);
      if (journal.cachedResponse) {
        yield { type: 'start' };
        const cachedActivities = activityEventsForResponse(journal.cachedResponse);
        for (const event of cachedActivities) yield event;
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
              const dynamicActivities = activityEventsForResponse(originalResponse);
              for (const dynamicActivity of dynamicActivities) {
                if (dynamicActivity.activity) this.activity.emit(dynamicActivity.activity);
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
          const dynamicActivities = activityEventsForResponse(response);
          for (const dynamicActivity of dynamicActivities) {
            if (dynamicActivity.activity) this.activity.emit(dynamicActivity.activity);
            yield dynamicActivity;
          }
          if (response.content) yield { type: 'delta', text: response.content };
          const sanitizedResponse = responseForAgent(response);
          yield { type: 'complete', response: sanitizedResponse, usage: sanitizedResponse.usage };
        }
      } catch (error) {
        if (isAbortError(error)) {
          if (!completed) await this.requestJournal.fail(journal.requestId, 'Solicitação cancelada pelo usuário.');
          throw error;
        }
        if (!completed) {
          const normalized = normalizeProviderError(adapter.displayName, 'stream', error);
          await this.requestJournal.fail(journal.requestId, normalized.message);
          throw normalized;
        }
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
