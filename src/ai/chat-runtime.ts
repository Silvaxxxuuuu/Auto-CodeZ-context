import type { AIProviderConfig, AIResponse, ChatRecord } from './types';
import { ActivityRuntime } from '../agent/activity-runtime';
import { CapabilityResolver } from './capability-resolver';
import { IntelligenceRuntime } from './intelligence-runtime';
import { ProviderRegistry } from './provider-registry';

export class ChatRuntime {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly capabilities = new CapabilityResolver(),
    private readonly intelligence = new IntelligenceRuntime(capabilities),
    private readonly activity = new ActivityRuntime(),
  ) {}

  async send(config: AIProviderConfig, chat: ChatRecord): Promise<AIResponse> {
    const adapter = this.registry.get(config.id);
    const models = await adapter.listModels(config);
    const model = models.find((item) => item.id === chat.model);
    if (!model) throw new Error(`Modelo '${chat.model}' não está disponível para este provider.`);
    if (!this.capabilities.supports(model, 'text')) throw new Error('O modelo selecionado não suporta texto.');

    const resolution = this.intelligence.resolve(model, chat.intelligence);
    this.activity.start('action', `Enviando mensagem para ${adapter.displayName}`);
    if (!resolution.supported) this.activity.emit({ type: 'action', message: `Perfil ${chat.intelligence} ajustado para ${resolution.effective}.`, status: 'success' });

    try {
      const request = {
        providerId: config.id,
        model: chat.model,
        messages: chat.messages,
        intelligence: resolution.effective,
        toolsEnabled: this.capabilities.supports(model, 'tools'),
      };
      const response = await adapter.send(config, request);
      this.activity.success('complete', 'Resposta recebida.');
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.failure('error', message);
      throw error;
    }
  }
}
