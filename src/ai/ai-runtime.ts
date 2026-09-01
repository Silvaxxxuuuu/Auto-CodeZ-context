import type { AIProviderConfig, AIRequest, AIResponse, IntelligenceLevel } from './types';
import { ProviderRegistry } from './provider-registry';

export class AIRuntime {
  constructor(private readonly registry: ProviderRegistry) {}

  async send(
    config: AIProviderConfig,
    messages: AIRequest['messages'],
    model: string,
    intelligence: IntelligenceLevel,
    projectContext?: string,
  ): Promise<AIResponse> {
    const request: AIRequest = {
      providerId: config.id,
      model,
      messages,
      intelligence,
      projectContext,
      toolsEnabled: true,
    };
    return this.registry.get(config.id).send(config, request);
  }
}
