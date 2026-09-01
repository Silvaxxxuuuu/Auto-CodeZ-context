import crypto from 'node:crypto';
import type { AIProviderConfig, ProviderId, ProviderSummary } from './types';
import { ProviderRegistry } from './provider-registry';
import { OpenAIAdapter } from './providers/openai';
import { GoogleAdapter } from './providers/google';
import { AnthropicAdapter } from './providers/anthropic';
import { selectDefaultModel } from './model-selection';
import { isAuthenticationError, normalizeProviderError } from './provider-errors';

const STATE_FILE = 'providers.json';
const SECURE_FILE = 'provider-secrets.json';
const KEY_STATE_FILE = 'provider-keys.json';
const KEY_SECURE_FILE = 'provider-key-secrets.json';

interface ProviderState { configs: AIProviderConfig[]; }
interface ProviderKeyRecord { id: string; name: string; providerId: ProviderId; apiKey: string; baseUrl?: string; selectedModel?: string; createdAt: number; updatedAt: number; }
interface ProviderKeyMetadata { id: string; name: string; providerId: ProviderId; baseUrl?: string; selectedModel?: string; createdAt: number; updatedAt: number; }
interface ProviderKeyState { keys: ProviderKeyMetadata[]; activeKeyIds: Record<string, string>; }
export interface ProviderKeySummary { id: string; name: string; providerId: ProviderId; providerName: string; maskedKey: string; selectedModel?: string; active: boolean; createdAt: number; updatedAt: number; }

function normalizeConfig(value: AIProviderConfig): AIProviderConfig {
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const displayName = typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : value.id;
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim().replace(/\/$/, '') : '';
  const selectedModel = typeof value.selectedModel === 'string' ? value.selectedModel.trim() : '';
  return { id: value.id, displayName, apiKey, ...(baseUrl ? { baseUrl } : {}), ...(selectedModel ? { selectedModel } : {}), enabled: Boolean(value.enabled && apiKey) };
}

function normalizeKey(value: ProviderKeyRecord): ProviderKeyRecord {
  const now = Date.now();
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'API Key';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  return { id: value.id, name: name.slice(0, 80), providerId: value.providerId, apiKey, ...(value.baseUrl?.trim() ? { baseUrl: value.baseUrl.trim().replace(/\/$/, '') } : {}), ...(value.selectedModel?.trim() ? { selectedModel: value.selectedModel.trim() } : {}), createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now };
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}`;
}

export class ProviderManager {
  readonly registry: ProviderRegistry;
  private configs: AIProviderConfig[] = [];
  private keys: ProviderKeyRecord[] = [];
  private activeKeyIds: Record<string, string> = {};

  constructor(private readonly storage: { read<T>(name: string, fallback: T): Promise<T>; write<T>(name: string, value: T): Promise<void>; readEncrypted(name: string): Promise<string | null>; writeEncrypted(name: string, value: string): Promise<void> }) {
    this.registry = new ProviderRegistry();
    this.registry.register(new OpenAIAdapter());
    this.registry.register(new GoogleAdapter());
    this.registry.register(new AnthropicAdapter());
  }

  async init(): Promise<void> {
    const metadata = await this.storage.read<ProviderState>(STATE_FILE, { configs: [] });
    const keyMetadata = await this.storage.read<ProviderKeyState>(KEY_STATE_FILE, { keys: [], activeKeyIds: {} });
    this.activeKeyIds = keyMetadata.activeKeyIds && typeof keyMetadata.activeKeyIds === 'object' ? { ...keyMetadata.activeKeyIds } : {};
    let secureKeys: ProviderKeyRecord[] = [];
    const rawKeySecure = await this.storage.readEncrypted(KEY_SECURE_FILE);
    if (rawKeySecure) {
      try {
        const parsed = JSON.parse(rawKeySecure) as { keys?: ProviderKeyRecord[] };
        if (Array.isArray(parsed.keys)) secureKeys = parsed.keys.map(normalizeKey).filter((key) => key.apiKey);
      } catch { secureKeys = []; }
    }
    if (!secureKeys.length) {
      const rawLegacy = await this.storage.readEncrypted(SECURE_FILE);
      if (rawLegacy) {
        try {
          const parsed = JSON.parse(rawLegacy) as ProviderState;
          if (Array.isArray(parsed.configs)) secureKeys = parsed.configs.map((config) => normalizeKey({ id: `legacy-${config.id}`, name: `${config.displayName} principal`, providerId: config.id, apiKey: config.apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.selectedModel ? { selectedModel: config.selectedModel } : {}), createdAt: Date.now(), updatedAt: Date.now() })).filter((key) => key.apiKey);
        } catch { secureKeys = []; }
      }
    }
    this.keys = secureKeys;
    if (!Object.keys(this.activeKeyIds).length) for (const key of this.keys) this.activeKeyIds[key.providerId] = key.id;
    this.syncConfigs();
    if (this.keys.length) await this.persistKeys();
    else {
      const metadataConfigs = Array.isArray(metadata.configs) ? metadata.configs : [];
      this.configs = metadataConfigs.map((item) => normalizeConfig({ ...item, apiKey: '' }));
      await this.persist();
    }
  }

  async list(): Promise<ProviderSummary[]> { return this.registry.summaries(this.configs); }

  getConfig(providerId: ProviderId): AIProviderConfig {
    const config = this.configs.find((item) => item.id === providerId);
    if (!config?.enabled || !config.apiKey) throw new Error(`Provider '${providerId}' não está configurado.`);
    return { ...config };
  }

  async listModels(providerId: ProviderId): Promise<import('./types').AIModel[]> {
    const config = this.getConfig(providerId);
    try { return await this.registry.listModels(config); } catch (error) { throw normalizeProviderError(config.displayName, 'model discovery', error); }
  }

  async listKeys(): Promise<ProviderKeySummary[]> {
    return this.keys.map((key) => ({ id: key.id, name: key.name, providerId: key.providerId, providerName: this.registry.get(key.providerId).displayName, maskedKey: maskApiKey(key.apiKey), ...(key.selectedModel ? { selectedModel: key.selectedModel } : {}), active: this.activeKeyIds[key.providerId] === key.id, createdAt: key.createdAt, updatedAt: key.updatedAt }));
  }

  async saveKey(input: { providerId: string; name: string; apiKey: string; model?: string; baseUrl?: string }): Promise<{ key: ProviderKeySummary; providers: ProviderSummary[]; models: import('./types').AIModel[]; discoveryError?: string }> {
    const providerId = input.providerId as ProviderId;
    const adapter = this.registry.get(providerId);
    const apiKey = input.apiKey.trim();
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!apiKey) throw new Error('API key é obrigatória.');
    if (!name) throw new Error('O nome da API key é obrigatório.');
    if (name.length > 80) throw new Error('O nome da API key deve ter no máximo 80 caracteres.');
    const config: AIProviderConfig = { id: providerId, displayName: adapter.displayName, apiKey, ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim().replace(/\/$/, '') } : {}), ...(input.model?.trim() ? { selectedModel: input.model.trim() } : {}), enabled: true };
    const discovery = await this.discover(config);
    const now = Date.now();
    const key: ProviderKeyRecord = { id: crypto.randomUUID(), name: name.slice(0, 80), providerId, apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.selectedModel ? { selectedModel: config.selectedModel } : {}), createdAt: now, updatedAt: now };
    this.keys = [...this.keys, key];
    this.activeKeyIds[providerId] = key.id;
    this.syncConfigs();
    await this.persistKeys();
    return { key: (await this.listKeys()).find((item) => item.id === key.id)!, providers: await this.list(), models: discovery.models, ...(discovery.discoveryError ? { discoveryError: discovery.discoveryError } : {}) };
  }

  async renameKey(keyId: string, name: string): Promise<ProviderKeySummary> {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) throw new Error('API key não encontrada.');
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new Error('O nome da API key é obrigatório.');
    if (normalized.length > 80) throw new Error('O nome da API key deve ter no máximo 80 caracteres.');
    key.name = normalized;
    key.updatedAt = Date.now();
    await this.persistKeys();
    return (await this.listKeys()).find((item) => item.id === keyId)!;
  }

  async setActiveKey(keyId: string): Promise<{ key: ProviderKeySummary; providers: ProviderSummary[] }> {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) throw new Error('API key não encontrada.');
    this.activeKeyIds[key.providerId] = key.id;
    this.syncConfigs();
    await this.persistKeys();
    return { key: (await this.listKeys()).find((item) => item.id === keyId)!, providers: await this.list() };
  }

  async removeKey(keyId: string): Promise<{ providers: ProviderSummary[]; keys: ProviderKeySummary[] }> {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) throw new Error('API key não encontrada.');
    this.keys = this.keys.filter((item) => item.id !== keyId);
    if (this.activeKeyIds[key.providerId] === keyId) {
      const replacement = this.keys.filter((item) => item.providerId === key.providerId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (replacement) this.activeKeyIds[key.providerId] = replacement.id;
      else delete this.activeKeyIds[key.providerId];
    }
    this.syncConfigs();
    await this.persistKeys();
    return { providers: await this.list(), keys: await this.listKeys() };
  }

  async save(input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }): Promise<{ providers: ProviderSummary[]; models: import('./types').AIModel[]; discoveryError?: string }> {
    const providerId = input.providerId as ProviderId;
    const adapter = this.registry.get(providerId);
    const apiKey = input.apiKey.trim();
    const active = this.keys.find((key) => key.id === this.activeKeyIds[providerId]);
    const config: AIProviderConfig = { id: providerId, displayName: adapter.displayName, apiKey, ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim().replace(/\/$/, '') } : {}), ...(input.model?.trim() ? { selectedModel: input.model.trim() } : {}), enabled: true };
    const discovery = await this.discover(config);
    if (active) {
      active.apiKey = apiKey;
      active.baseUrl = config.baseUrl;
      active.selectedModel = config.selectedModel;
      active.updatedAt = Date.now();
    } else {
      const key: ProviderKeyRecord = { id: crypto.randomUUID(), name: `${adapter.displayName} principal`, providerId, apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}), ...(config.selectedModel ? { selectedModel: config.selectedModel } : {}), createdAt: Date.now(), updatedAt: Date.now() };
      this.keys = [...this.keys, key];
      this.activeKeyIds[providerId] = key.id;
    }
    this.syncConfigs();
    await this.persistKeys();
    return { providers: await this.list(), models: discovery.models, ...(discovery.discoveryError ? { discoveryError: discovery.discoveryError } : {}) };
  }

  async remove(providerId: ProviderId): Promise<ProviderSummary[]> {
    this.keys = this.keys.filter((key) => key.providerId !== providerId);
    delete this.activeKeyIds[providerId];
    this.syncConfigs();
    await this.persistKeys();
    return this.list();
  }

  private async discover(config: AIProviderConfig): Promise<{ models: import('./types').AIModel[]; discoveryError?: string }> {
    let models: import('./types').AIModel[] = [];
    let discoveryError: string | undefined;
    const adapter = this.registry.get(config.id);
    try {
      models = await adapter.listModels(config);
      if (!models.length) discoveryError = 'O provider não retornou modelos disponíveis. A API key foi salva.';
    } catch (error) {
      const normalized = normalizeProviderError(config.displayName, 'model discovery', error);
      if (isAuthenticationError(normalized)) throw normalized;
      discoveryError = normalized.message || 'Não foi possível descobrir os modelos agora. A API key foi salva.';
    }
    if (config.selectedModel && models.length && !models.some((model) => model.id === config.selectedModel)) throw new Error('O modelo selecionado não está disponível para este provider.');
    if (!config.selectedModel && models.length) config.selectedModel = selectDefaultModel(config.id, models);
    return { models, ...(discoveryError ? { discoveryError } : {}) };
  }

  private syncConfigs(): void {
    this.configs = this.registry.list().flatMap((adapter) => {
      const key = this.keys.find((item) => item.id === this.activeKeyIds[adapter.id]);
      return key ? [{ id: adapter.id, displayName: adapter.displayName, apiKey: key.apiKey, ...(key.baseUrl ? { baseUrl: key.baseUrl } : {}), ...(key.selectedModel ? { selectedModel: key.selectedModel } : {}), enabled: true }] : [];
    });
  }

  private async persistKeys(): Promise<void> {
    const metadata: ProviderKeyState = { keys: this.keys.map(({ apiKey: _apiKey, ...key }) => key), activeKeyIds: this.activeKeyIds };
    await this.storage.write(KEY_STATE_FILE, metadata);
    await this.storage.writeEncrypted(KEY_SECURE_FILE, JSON.stringify({ keys: this.keys }));
    await this.storage.write(STATE_FILE, { configs: this.configs.map((config) => ({ ...config, apiKey: '' })) });
    await this.storage.writeEncrypted(SECURE_FILE, JSON.stringify({ configs: this.configs } satisfies ProviderState));
  }

  private async persist(): Promise<void> {
    await this.storage.write(STATE_FILE, { configs: this.configs.map((config) => ({ ...config, apiKey: '' })) });
    await this.storage.writeEncrypted(SECURE_FILE, JSON.stringify({ configs: this.configs } satisfies ProviderState));
  }
}

export { selectDefaultModel } from './model-selection';
