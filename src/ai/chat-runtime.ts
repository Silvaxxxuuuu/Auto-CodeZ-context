import type { AIProviderConfig, AIResponse, AIStreamEvent, AIToolDefinition, ChatRecord } from './types';
import { ActivityRuntime } from '../agent/activity-runtime';
import { CapabilityResolver } from './capability-resolver';
import { IntelligenceRuntime } from './intelligence-runtime';
import { ModelResolver } from './model-resolver';
import { ProviderRegistry } from './provider-registry';

export class ChatRuntime {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly capabilities = new CapabilityResolver(),
    private readonly intelligence = new IntelligenceRuntime(capabilities),
    private readonly activity = new ActivityRuntime(),
    private readonly models = new ModelResolver(registry),
    private readonly toolDefinitions: AIToolDefinition[] = [],
  ) {}

  private async prepare(config: AIProviderConfig, chat: ChatRecord, projectContext?: string) {
    const adapter = this.registry.get(config.id);
    const availableModels = await this.models.list(config);
    const model = this.models.find(availableModels, chat.model);
    if (!this.capabilities.supports(model, 'text')) throw new Error('O modelo selecionado não suporta texto.');
    const resolution = this.intelligence.resolve(model, chat.intelligence);
    const messages = projectContext
      ? [{ role: 'system' as const, content: `Contexto do workspace atual:\n${projectContext}` }, ...chat.messages]
      : chat.messages;
    const toolsEnabled = this.capabilities.supports(model, 'tools');
    return {
      adapter,
      request: {
        providerId: config.id,
        model: chat.model,
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
    const { adapter, request, resolution } = await this.prepare(config, chat, projectContext);
    this.activity.start('action', `Enviando mensagem para ${adapter.displayName}`);
    if (projectContext) this.activity.emit({ type: 'action', message: 'Contexto do workspace anexado à solicitação.', status: 'success' });
    if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });

    try {
      const response = await adapter.send(config, request);
      this.activity.success('complete', 'Resposta recebida.');
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('error', message);
      throw error;
    }
  }

  async *stream(config: AIProviderConfig, chat: ChatRecord, projectContext?: string): AsyncGenerator<AIStreamEvent> {
    const { adapter, request, resolution } = await this.prepare(config, chat, projectContext);
    this.activity.start('action', `Transmitindo resposta de ${adapter.displayName}`);
    if (projectContext) this.activity.emit({ type: 'action', message: 'Contexto do workspace anexado à solicitação.', status: 'success' });
    if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });

    try {
      if (adapter.stream) {
        for await (const event of adapter.stream(config, request)) {
          if (event.type === 'activity' && event.activity) this.activity.emit(event.activity);
          yield event;
        }
      } else {
        const response = await adapter.send(config, request);
        yield { type: 'start' };
        if (response.content) yield { type: 'delta', text: response.content };
        yield { type: 'complete', response, usage: response.usage };
      }
      this.activity.success('complete', 'Resposta recebida.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('error', message);
      yield { type: 'error', error: message };
    }
  }
}
