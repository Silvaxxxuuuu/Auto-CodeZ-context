import { PluginRegistry } from './plugin-registry';
import { PluginActivityRuntime, type PluginActivityStatus } from './plugin-activity-runtime';
import { PluginJobRuntime } from './plugin-job-runtime';
import { PluginLocalBridgeRuntime, type PluginBridgeRequest } from './plugin-local-bridge';
import { PluginSettingsStore } from './plugin-settings-store';
import { pluginToolCatalog, type PluginToolRegistration } from './plugin-tool-catalog';
import type { PluginPermission } from './plugin-types';
import { WebRetrievalRuntime } from '../web/web-retrieval-runtime';

export type PluginCapabilityRequest = {
  id: string;
  method: string;
  input?: unknown;
};

export type PluginCapabilityResponse = {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

export type PluginExternalCapabilityHandler = (pluginId: string, input: unknown) => Promise<unknown>;

type CapabilityDescriptor = {
  permission?: PluginPermission;
  handler: PluginExternalCapabilityHandler;
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD_PATTERN = /^[a-z][a-z0-9.-]{1,127}$/;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Payload de capability inválido.');
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maxLength = 2048): string {
  if (typeof value !== 'string') throw new Error(`${field} inválido.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} inválido.`);
  return normalized;
}

function assertSerializableSize(value: unknown, maxBytes: number, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(`${label} excede o limite permitido.`);
}

function requireToolRegistrations(input: unknown): PluginToolRegistration[] {
  const value = requireRecord(input);
  if (!Array.isArray(value.tools)) throw new Error('Lista de tools do plugin inválida.');
  return value.tools as PluginToolRegistration[];
}

export class PluginCapabilityBroker {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  constructor(
    private readonly registry: PluginRegistry,
    private readonly settings: PluginSettingsStore,
    private readonly activities = new PluginActivityRuntime(),
    private readonly jobs = new PluginJobRuntime(),
    private readonly localBridge = new PluginLocalBridgeRuntime(),
    private readonly web = new WebRetrievalRuntime(),
  ) {
    this.registerBuiltins();
  }

  register(method: string, permission: PluginPermission | undefined, handler: PluginExternalCapabilityHandler): void {
    if (!METHOD_PATTERN.test(method)) throw new Error('Nome de capability inválido.');
    if (this.capabilities.has(method)) throw new Error(`Capability '${method}' já está registrada.`);
    this.capabilities.set(method, { ...(permission ? { permission } : {}), handler });
  }

  async invoke(pluginId: string, request: PluginCapabilityRequest): Promise<PluginCapabilityResponse> {
    const id = request?.id;
    try {
      if (!REQUEST_ID_PATTERN.test(id)) throw new Error('ID da solicitação de plugin inválido.');
      if (!METHOD_PATTERN.test(request.method)) throw new Error('Método de capability inválido.');
      assertSerializableSize(request.input ?? null, MAX_REQUEST_BYTES, 'Payload da solicitação');
      const plugin = this.registry.get(pluginId);
      if (!plugin || plugin.state !== 'enabled') throw new Error(`Plugin '${pluginId}' não está habilitado.`);
      const descriptor = this.capabilities.get(request.method);
      if (!descriptor) throw new Error(`Capability '${request.method}' não existe.`);
      if (descriptor.permission && !this.registry.hasPermission(pluginId, descriptor.permission)) {
        throw new Error(`Plugin '${pluginId}' não possui a permissão '${descriptor.permission}'.`);
      }
      const value = await descriptor.handler(pluginId, structuredClone(request.input));
      assertSerializableSize(value ?? null, MAX_RESPONSE_BYTES, 'Resposta da capability');
      return { id, ok: true, value: structuredClone(value) };
    } catch (error) {
      return {
        id: REQUEST_ID_PATTERN.test(id ?? '') ? id : 'invalid',
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
      };
    }
  }

  getActivityRuntime(): PluginActivityRuntime {
    return this.activities;
  }

  getJobRuntime(): PluginJobRuntime {
    return this.jobs;
  }

  cancelPluginWork(pluginId: string): void {
    this.jobs.cancelPlugin(pluginId);
    this.activities.clear(pluginId);
    pluginToolCatalog.clear(pluginId);
  }

  private registerBuiltins(): void {
    this.register('settings.list', undefined, async (pluginId) => this.settings.list(pluginId));
    this.register('settings.get', undefined, async (pluginId, input) => {
      const value = requireRecord(input);
      return this.settings.get(pluginId, requireString(value.key, 'Chave', 128));
    });
    this.register('settings.set', undefined, async (pluginId, input) => {
      const value = requireRecord(input);
      const key = requireString(value.key, 'Chave', 128);
      await this.settings.set(pluginId, key, value.value);
      return { saved: true };
    });
    this.register('settings.remove', undefined, async (pluginId, input) => {
      const value = requireRecord(input);
      await this.settings.remove(pluginId, requireString(value.key, 'Chave', 128));
      return { removed: true };
    });
    this.register('activity.publish', undefined, async (pluginId, input) => {
      const value = requireRecord(input);
      const status = value.status === undefined ? 'running' : requireString(value.status, 'Status', 32);
      if (!['running', 'waiting', 'completed', 'failed'].includes(status)) throw new Error('Status de atividade inválido.');
      return this.activities.publish(pluginId, requireString(value.message, 'Mensagem', 512), status as PluginActivityStatus);
    });
    this.register('activity.clear', undefined, async (pluginId) => ({ cleared: this.activities.clear(pluginId) }));
    this.register('tools.register', 'ai:tool', async (pluginId, input) => {
      const plugin = this.registry.get(pluginId);
      if (!plugin?.manifest.contributions.includes('tool')) throw new Error(`Plugin '${pluginId}' não declarou contribuição de tool.`);
      return pluginToolCatalog.register(pluginId, requireToolRegistrations(input));
    });
    this.register('bridge.request', 'network:localhost', async (_pluginId, input) => {
      const value = requireRecord(input);
      return this.localBridge.request(value as unknown as PluginBridgeRequest);
    });
    this.register('web.search', 'network:fetch', async (_pluginId, input) => {
      const value = requireRecord(input);
      const limit = typeof value.limit === 'number' ? value.limit : undefined;
      return this.web.search(requireString(value.query, 'Consulta', 4096), { ...(limit !== undefined ? { limit } : {}) });
    });
    this.register('web.fetch', 'network:fetch', async (_pluginId, input) => {
      const value = requireRecord(input);
      return this.web.fetch(requireString(value.url, 'URL', 8192));
    });
  }
}
