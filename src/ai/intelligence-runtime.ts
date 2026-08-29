import type { AIModel, IntelligenceLevel } from './types';
import { CapabilityResolver } from './capability-resolver';

export interface IntelligenceResolution {
  requested: IntelligenceLevel;
  effective: IntelligenceLevel;
  supported: boolean;
}

export class IntelligenceRuntime {
  constructor(private readonly capabilities = new CapabilityResolver()) {}

  resolve(model: AIModel, requested: IntelligenceLevel): IntelligenceResolution {
    const effective = this.capabilities.resolveIntelligence(model, requested);
    return { requested, effective, supported: effective === requested };
  }
}
