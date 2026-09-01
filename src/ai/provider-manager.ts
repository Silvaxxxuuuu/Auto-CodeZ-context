import type { AIModel, AIProviderConfig, ProviderId, ProviderSummary } from './types';
import { ProviderRegistry } from './provider-registry';
import { OpenAIAdapter } from './providers/openai';
import { GoogleAdapter } from './providers/google';
import { AnthropicAdapter } from './providers/anthropic';

const STATE_FILE = 'providers.json';
const SECURE_FILE = 'provider-secrets.json';

interface ProviderState { configs: AIProviderConfig[]; }

const DEFAULT_MODEL_PREFERENCES: Partial<Record<ProviderId, string[]>> = {
  google: [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
};

function modelScore(model: AIModel): number {
  const id = `${model.id} ${model.name}`.toLowerCase();
  let score = 0;
  if (model.capabilities.includes('text')) score += 100;
  if (model.capabilities.includes('tools')) score += 80;
  if (model.capabilities.includes('streaming')) score += 40;
  if (model.capabilities.includes('reasoning')) score += 20;
  if (model.capabilities.includes('vision')) score += 10;
  if (/(?:^|[-_.])(?:preview|experimental|exp|beta|alpha)(?:[-_.]|$)/i.test(id)) score -= 35;
  if (/(?:deprecated|legacy|old)/i.test(id)) score -= 100;
  if (/(?:lite|nano|micro|tiny)/i.test(id)) score -= 25;
  if (/(?:mini|haiku)/i.test(id)) score -= 10;
  if (/(?:pro|opus)/i.test(id)) score += 8;
  const versionNumbers = id.match(/(?:^|[-_.])(?:gpt|claude|gemini)?[-_.]?(\d+(?:\.\d+)?)/i);
  if (versionNumbers?.[1]) score += Number(versionNumbers[1]) * 2;
  return score;
}

export function selectDefaultModel(providerId: ProviderId, models: AIModel[]): string | undefined {
  const preferred = DEFAULT_MODEL_PREFERENCES[providerId] || [];
  const exactPreferred = preferred.find((id) => models.some((model) => model.id === id));
  if (exactPreferred) return exactPreferred;
  return [...models].sort((left, right) => modelScore(right) - modelScore(left))[0]?.id;
}

function normalizeConfig(value: AIProviderConfig): AIProviderConfig {
  return { id: value.id, displayName: value.displayName, apiKey: value.apiKey, ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}), ...(value.selectedModel ? { selectedModel: value.selectedModel } : {}), enabled: Boolean(value.enabled) };
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

  async listModels(providerId: ProviderId): Promise<AIModel[]> { return this.registry.listModels(this.getConfig(providerId)); }

  async save(input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }): Promise<{ providers: ProviderSummary[]; models: AIModel[] }> {
    const providerId = input.providerId as ProviderId;
    const adapter = this.registry.get(providerId);
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error('API key é obrigatória.');
    const config: AIProviderConfig = { id: providerId, displayName: adapter.displayName, apiKey, ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim().replace(/\/$/, '') } : {}), ...(input.model?.trim() ? { selectedModel: input.model.trim() } : {}), enabled: true };
    const models = await adapter.listModels(config);
    if (!models.length) throw new Error('O provider não retornou modelos disponíveis.');
    if (config.selectedModel && !models.some((model) => model.id === config.selectedModel)) throw new Error('O modelo selecionado não está disponível para este provider.');
    config.selectedModel ||= selectDefaultModel(providerId, models);
    this.configs = [...this.configs.filter((item) => item.id !== providerId), config];
    await this.persist();
    return { providers: await this.list(), models };
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
