import type { AIProviderConfig, ProviderId, ProviderSummary } from './types';
import { ProviderRegistry } from './provider-registry';
import { OpenAIAdapter } from './providers/openai';
import { GoogleAdapter } from './providers/google';
import { AnthropicAdapter } from './providers/anthropic';
import { selectDefaultModel } from './model-selection';

const STATE_FILE = 'providers.json';
const SECURE_FILE = 'provider-secrets.json';

interface ProviderState { configs: AIProviderConfig[]; }

function normalizeConfig(value: AIProviderConfig): AIProviderConfig {
  return { id: value.id, displayName: value.displayName, apiKey: value.apiKey, ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}), ...(value.selectedModel ? { selectedModel: value.selectedModel } : {}), enabled: Boolean(value.enabled) };
}

function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /(?:invalid\s+(?:api\s*)?key|api\s*key.*(?:invalid|incorrect|not\s+valid)|invalid\s+authentication|unauthorized|authentication.*failed|permission\s+denied|forbidden)/i.test(message);
}

export class ProviderManager {
  readonly registry: ProviderRegistry;
  private configs: AIProviderConfig[] = [];

  constructor(private readonly storage: { read<T>(name: string, fallback: T): Promise<T>; write<T>(name: string, value: T): Promise<void>; readEncrypted(name: string): Promise<string | null>; writeEncrypted(name: string, value: string): Promise<void> }) {
    this.registry = new ProviderRegistry();
    this.registry.register(new OpenAIAdapter());
    this.registry.register(new GoogleAdapter());
    this.registry.register(new AnthropicAdapter());
  }

  async init(): Promise<void> {
    const metadata = await this.storage.read<ProviderState>(STATE_FILE, { configs: [] });
    let secure: AIProviderConfig[] = [];
    const rawSecure = await this.storage.readEncrypted(SECURE_FILE);
    if (rawSecure) {
      try {
        const parsed = JSON.parse(rawSecure) as ProviderState;
        if (Array.isArray(parsed.configs)) secure = parsed.configs.map(normalizeConfig);
      } catch { secure = []; }
    }
    const metadataConfigs = Array.isArray(metadata.configs) ? metadata.configs : [];
    this.configs = metadataConfigs.map((item) => {
      const secureConfig = secure.find((candidate) => candidate.id === item.id);
      return normalizeConfig({ ...item, apiKey: secureConfig?.apiKey || '' });
    });
    await this.persist();
  }

  async list(): Promise<ProviderSummary[]> { return this.registry.summaries(this.configs); }

  getConfig(providerId: ProviderId): AIProviderConfig {
    const config = this.configs.find((item) => item.id === providerId);
    if (!config?.enabled || !config.apiKey) throw new Error(`Provider '${providerId}' não está configurado.`);
    return { ...config };
  }

  async listModels(providerId: ProviderId): Promise<import('./types').AIModel[]> { return this.registry.listModels(this.getConfig(providerId)); }

  async save(input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }): Promise<{ providers: ProviderSummary[]; models: import('./types').AIModel[]; discoveryError?: string }> {
    const providerId = input.providerId as ProviderId;
    const adapter = this.registry.get(providerId);
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error('API key é obrigatória.');
    const config: AIProviderConfig = { id: providerId, displayName: adapter.displayName, apiKey, ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim().replace(/\/$/, '') } : {}), ...(input.model?.trim() ? { selectedModel: input.model.trim() } : {}), enabled: true };
    let models: import('./types').AIModel[] = [];
    let discoveryError: string | undefined;
    try {
      models = await adapter.listModels(config);
      if (!models.length) discoveryError = 'O provider não retornou modelos disponíveis. A API key foi salva e a descoberta de modelos poderá ser repetida.';
    } catch (error) {
      if (isAuthenticationFailure(error)) throw error;
      discoveryError = error instanceof Error ? error.message : 'Não foi possível descobrir os modelos deste provider agora. A API key foi salva.';
    }
    if (config.selectedModel && models.length && !models.some((model) => model.id === config.selectedModel)) throw new Error('O modelo selecionado não está disponível para este provider.');
    if (!config.selectedModel && models.length) config.selectedModel = selectDefaultModel(providerId, models);
    this.configs = [...this.configs.filter((item) => item.id !== providerId), config];
    await this.persist();
    return { providers: await this.list(), models, ...(discoveryError ? { discoveryError } : {}) };
  }

  async remove(providerId: ProviderId): Promise<ProviderSummary[]> {
    this.configs = this.configs.filter((item) => item.id !== providerId);
    await this.persist();
    return this.list();
  }

  private async persist(): Promise<void> {
    await this.storage.write(STATE_FILE, { configs: this.configs.map((config) => ({ ...config, apiKey: '' })) });
    await this.storage.writeEncrypted(SECURE_FILE, JSON.stringify({ configs: this.configs } satisfies ProviderState));
  }
}

export { selectDefaultModel } from './model-selection';
