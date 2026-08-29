import type { AIModel, Capability, IntelligenceLevel } from './types';

export class CapabilityResolver {
  supports(model: AIModel, capability: Capability): boolean {
    return model.capabilities.includes(capability);
  }

  supportsAny(model: AIModel, capabilities: Capability[]): boolean {
    return capabilities.some((capability) => this.supports(model, capability));
  }

  supportsAll(model: AIModel, capabilities: Capability[]): boolean {
    return capabilities.every((capability) => this.supports(model, capability));
  }

  availableIntelligence(model: AIModel): IntelligenceLevel[] {
    return model.reasoningLevels?.length ? [...model.reasoningLevels] : ['normal'];
  }

  resolveIntelligence(model: AIModel, requested: IntelligenceLevel): IntelligenceLevel {
    const available = this.availableIntelligence(model);
    if (available.includes(requested)) return requested;
    const order: IntelligenceLevel[] = ['low', 'normal', 'high', 'maximum'];
    const requestedIndex = order.indexOf(requested);
    const compatible = order
      .filter((level) => available.includes(level))
      .sort((a, b) => Math.abs(order.indexOf(a) - requestedIndex) - Math.abs(order.indexOf(b) - requestedIndex));
    return compatible[0] || 'normal';
  }
}
