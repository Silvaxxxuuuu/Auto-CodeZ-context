export type PluginSandboxBridge = {
  invoke(pluginId: string, request: { id: string; method: string; input?: unknown }): Promise<{ id: string; ok: boolean; value?: unknown; error?: string }>;
  markHealthy(pluginId: string, message?: string): Promise<unknown>;
  markFailed(pluginId: string, reason: string): Promise<unknown>;
};

type SandboxMessage = {
  channel: 'autocodez-plugin';
  type: 'request' | 'ready' | 'failed' | 'call-result';
  id?: string;
  method?: string;
  input?: unknown;
  value?: unknown;
  error?: string;
};

type SandboxInstance = {
  iframe: HTMLIFrameElement;
  pluginId: string;
  ready: Promise<void>;
  calls: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>;
};

const MAX_SOURCE_CHARS = 2 * 1024 * 1024;
const ACTIVATION_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

const SANDBOX_DOCUMENT = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; img-src 'none'; media-src 'none'; style-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"></head>
<body><script>
(() => {
  const CHANNEL = 'autocodez-plugin';
  let worker = null;
  const send = (payload) => parent.postMessage({ channel: CHANNEL, ...payload }, '*');
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === 'boot') {
      if (worker) return;
      const prefix = \`
'use strict';
let registration = null;
let sequence = 0;
const pending = new Map();
const send = (payload) => postMessage({ channel: '${'autocodez-plugin'}', ...payload });
const request = (method, input) => new Promise((resolve, reject) => {
  const id = 'req-' + (++sequence) + '-' + Math.random().toString(36).slice(2);
  pending.set(id, { resolve, reject });
  send({ type: 'request', id, method, input });
});
try { Object.defineProperty(globalThis, 'fetch', { value: undefined, writable: false, configurable: false }); } catch {}
try { Object.defineProperty(globalThis, 'WebSocket', { value: undefined, writable: false, configurable: false }); } catch {}
try { Object.defineProperty(globalThis, 'EventSource', { value: undefined, writable: false, configurable: false }); } catch {}
try { Object.defineProperty(globalThis, 'importScripts', { value: undefined, writable: false, configurable: false }); } catch {}
const api = Object.freeze({
  request,
  settings: Object.freeze({
    list: () => request('settings.list'),
    get: (key) => request('settings.get', { key }),
    set: (key, value) => request('settings.set', { key, value }),
    remove: (key) => request('settings.remove', { key }),
  }),
  activity: Object.freeze({
    publish: (message, status = 'running') => request('activity.publish', { message, status }),
    clear: () => request('activity.clear'),
  }),
  bridge: Object.freeze({ request: (input) => request('bridge.request', input) }),
  web: Object.freeze({
    search: (query, limit) => request('web.search', { query, limit }),
    fetch: (url) => request('web.fetch', { url }),
  }),
});
Object.defineProperty(globalThis, 'autoCodez', {
  value: Object.freeze({
    register(value) {
      if (registration) throw new Error('Plugin já registrou seu módulo.');
      if (!value || typeof value !== 'object') throw new Error('Registro do plugin inválido.');
      registration = value;
    },
  }),
  writable: false,
  configurable: false,
});
onmessage = async (event) => {
  const data = event.data;
  if (!data || data.channel !== '${'autocodez-plugin'}') return;
  if (data.type === 'response') {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.ok) item.resolve(data.value); else item.reject(new Error(data.error || 'Capability recusada.'));
    return;
  }
  if (data.type === 'call') {
    try {
      if (!registration || typeof registration.invoke !== 'function') throw new Error('Plugin não expõe invoke().');
      const value = await registration.invoke(data.method, data.input, api);
      send({ type: 'call-result', id: data.id, value });
    } catch (error) {
      send({ type: 'call-result', id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (data.type === 'deactivate') {
    try {
      if (registration && typeof registration.deactivate === 'function') await registration.deactivate(api);
    } finally {
      close();
    }
  }
};
\`;
      const suffix = \`
Promise.resolve().then(async () => {
  if (!registration) throw new Error('Plugin não chamou autoCodez.register().');
  if (registration.activate !== undefined && typeof registration.activate !== 'function') throw new Error('activate precisa ser função.');
  if (registration.deactivate !== undefined && typeof registration.deactivate !== 'function') throw new Error('deactivate precisa ser função.');
  if (registration.invoke !== undefined && typeof registration.invoke !== 'function') throw new Error('invoke precisa ser função.');
  if (registration.activate) await registration.activate(api);
  send({ type: 'ready' });
}).catch((error) => send({ type: 'failed', error: error instanceof Error ? error.message : String(error) }));
\`;
      const blob = new Blob([prefix, data.source, suffix], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url, { name: 'autocodez-plugin' });
      URL.revokeObjectURL(url);
      worker.onmessage = (workerEvent) => send(workerEvent.data || {});
      worker.onerror = (error) => send({ type: 'failed', error: error.message || 'Falha no worker do plugin.' });
      return;
    }
    if (!worker) return;
    worker.postMessage(data);
  });
})();
</script></body></html>`;

export class PluginSandboxManager {
  private readonly instances = new Map<string, SandboxInstance>();
  private readonly byWindow = new Map<Window, SandboxInstance>();
  private listening = false;

  constructor(private readonly bridge: PluginSandboxBridge) {}

  async activate(pluginId: string, source: string): Promise<void> {
    if (this.instances.has(pluginId)) return this.instances.get(pluginId)!.ready;
    if (!source || source.length > MAX_SOURCE_CHARS) throw new Error('Código do plugin inválido ou grande demais.');
    this.ensureListener();
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.sandbox.add('allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.srcdoc = SANDBOX_DOCUMENT;
    document.body.appendChild(iframe);

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const instance: SandboxInstance = { iframe, pluginId, ready, calls: new Map() };
    this.instances.set(pluginId, instance);

    const timeout = window.setTimeout(() => {
      rejectReady(new Error('Plugin excedeu o tempo de ativação.'));
      void this.bridge.markFailed(pluginId, 'Plugin excedeu o tempo de ativação.');
      this.destroy(pluginId);
    }, ACTIVATION_TIMEOUT_MS);

    const loaded = new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
    await loaded;
    if (!iframe.contentWindow) throw new Error('Sandbox do plugin não foi inicializado.');
    this.byWindow.set(iframe.contentWindow, instance);
    (instance as SandboxInstance & { resolveReady?: () => void; rejectReady?: (error: Error) => void; activationTimer?: number }).resolveReady = () => {
      window.clearTimeout(timeout);
      resolveReady();
    };
    (instance as SandboxInstance & { rejectReady?: (error: Error) => void; activationTimer?: number }).rejectReady = (error) => {
      window.clearTimeout(timeout);
      rejectReady(error);
    };
    iframe.contentWindow.postMessage({ channel: 'autocodez-plugin', type: 'boot', source }, '*');
    return ready;
  }

  async deactivate(pluginId: string): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (!instance) return;
    instance.iframe.contentWindow?.postMessage({ channel: 'autocodez-plugin', type: 'deactivate' }, '*');
    this.destroy(pluginId);
  }

  async call(pluginId: string, method: string, input?: unknown): Promise<unknown> {
    const instance = this.instances.get(pluginId);
    if (!instance) throw new Error(`Plugin '${pluginId}' não está ativo no sandbox.`);
    await instance.ready;
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        instance.calls.delete(id);
        reject(new Error('Chamada ao plugin excedeu o tempo limite.'));
      }, CALL_TIMEOUT_MS);
      instance.calls.set(id, { resolve, reject, timer });
      instance.iframe.contentWindow?.postMessage({ channel: 'autocodez-plugin', type: 'call', id, method, input }, '*');
    });
  }

  private ensureListener(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('message', (event) => void this.onMessage(event));
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const instance = this.byWindow.get(event.source as Window);
    if (!instance) return;
    const data = event.data as SandboxMessage;
    if (!data || data.channel !== 'autocodez-plugin') return;
    if (data.type === 'request') {
      if (!data.id || !data.method) return;
      const response = await this.bridge.invoke(instance.pluginId, { id: data.id, method: data.method, input: data.input });
      instance.iframe.contentWindow?.postMessage({ channel: 'autocodez-plugin', type: 'response', ...response }, '*');
      return;
    }
    if (data.type === 'ready') {
      const extended = instance as SandboxInstance & { resolveReady?: () => void };
      extended.resolveReady?.();
      await this.bridge.markHealthy(instance.pluginId, 'Plugin ativo em sandbox isolado.');
      return;
    }
    if (data.type === 'failed') {
      const error = new Error((data.error || 'Plugin falhou durante a ativação.').slice(0, 2048));
      const extended = instance as SandboxInstance & { rejectReady?: (error: Error) => void };
      extended.rejectReady?.(error);
      await this.bridge.markFailed(instance.pluginId, error.message);
      this.destroy(instance.pluginId);
      return;
    }
    if (data.type === 'call-result' && data.id) {
      const pending = instance.calls.get(data.id);
      if (!pending) return;
      instance.calls.delete(data.id);
      window.clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.value);
    }
  }

  private destroy(pluginId: string): void {
    const instance = this.instances.get(pluginId);
    if (!instance) return;
    for (const pending of instance.calls.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('Plugin foi desativado.'));
    }
    instance.calls.clear();
    if (instance.iframe.contentWindow) this.byWindow.delete(instance.iframe.contentWindow);
    instance.iframe.remove();
    this.instances.delete(pluginId);
  }
}
