import type { AIProviderConfig, AIResponse, AIStreamEvent, AIToolDefinition, ChatRecord } from './types';
import { ActivityRuntime } from '../agent/activity-runtime';
import { CapabilityResolver } from './capability-resolver';
import { IntelligenceRuntime } from './intelligence-runtime';
import { ModelResolver } from './model-resolver';
import { ProviderRegistry } from './provider-registry';
import { ProviderRequestJournal } from './provider-request-journal';
import { formatProviderError, normalizeProviderError } from './provider-errors';

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
    const messages = projectContext
      ? [{ role: 'system' as const, content: `Contexto do workspace atual:\n${projectContext}` }, ...chat.messages]
      : chat.messages;
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
        const normalized = normalizeProviderError(adapter.displayName, 'request', error);
        await this.requestJournal.fail(journal.requestId, normalized.message);
        throw normalized;
      }
    } catch (error) {
      const normalized = normalizeProviderError(config.displayName, 'request', error);
      const message = formatProviderError(normalized);
      this.activity.failure('error', message);
      throw new Error(message);
    }
  }

  async *stream(config: AIProviderConfig, chat: ChatRecord, projectContext?: string): AsyncGenerator<AIStreamEvent> {
    try {
      const { adapter, request, resolution } = await this.prepare(config, chat, projectContext);
      this.activity.start('action', `Transmitindo resposta de ${adapter.displayName}`);
      if (projectContext) this.activity.emit({ type: 'action', message: 'Contexto do workspace anexado à solicitação.', status: 'success' });
      if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });

      const journal = await this.requestJournal.begin(request);
      if (journal.cachedResponse) {
        yield { type: 'start' };
        if (journal.cachedResponse.content) yield { type: 'delta', text: journal.cachedResponse.content };
        yield { type: 'complete', response: journal.cachedResponse, usage: journal.cachedResponse.usage };
        return;
      }

      let completed = false;
      try {
        if (adapter.stream) {
          for await (const event of adapter.stream(config, request)) {
            if (event.type === 'activity' && event.activity) this.activity.emit(event.activity);
            if (event.type === 'complete' && event.response) {
              await this.requestJournal.complete(journal.requestId, event.response);
              completed = true;
            }
            if (event.type === 'error' && !completed) await this.requestJournal.fail(journal.requestId, event.error || 'Erro durante o streaming.');
            yield event;
          }
        } else {
          const response = await adapter.send(config, request);
          await this.requestJournal.complete(journal.requestId, response);
          completed = true;
          yield { type: 'start' };
          if (response.content) yield { type: 'delta', text: response.content };
          yield { type: 'complete', response, usage: response.usage };
        }
        this.activity.success('complete', 'Resposta recebida.');
      } catch (error) {
        if (!completed) {
          const normalized = normalizeProviderError(adapter.displayName, 'stream', error);
          await this.requestJournal.fail(journal.requestId, normalized.message);
          throw normalized;
        }
        throw error;
      }
    } catch (error) {
      const normalized = normalizeProviderError(config.displayName, 'stream', error);
      const message = formatProviderError(normalized);
      this.activity.failure('error', message);
      yield { type: 'error', error: message };
    }
  }
}
