import crypto from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

export type PluginSandboxCall = {
  id: string;
  pluginId: string;
  method: string;
  input?: unknown;
};

type PendingCall = {
  webContentsId: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

const CALL_TIMEOUT_MS = 30_000;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function assertSize(value: unknown, limit: number, label: string): void {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') > limit) throw new Error(`${label} excede o limite permitido.`);
}

export class PluginSandboxCallRouter {
  private readonly pending = new Map<string, PendingCall>();
  private target?: WebContents;

  bind(target: WebContents): void {
    if (target.isDestroyed()) throw new Error('Renderer de plugins indisponível.');
    if (this.target && !this.target.isDestroyed() && this.target.id !== target.id) {
      throw new Error('Plugin Platform já está vinculada a outro renderer ativo.');
    }
    if (this.target?.id === target.id) return;
    this.target = target;
    target.once('destroyed', () => {
      if (this.target?.id !== target.id) return;
      this.target = undefined;
      this.cancelAll('Renderer da Plugin Platform foi encerrado.');
    });
  }

  async call(pluginId: string, method: string, input?: unknown): Promise<unknown> {
    assertSize(input, MAX_INPUT_BYTES, 'Entrada da tool de plugin');
    const target = this.target;
    if (!target || target.isDestroyed()) throw new Error('Renderer da Plugin Platform não está registrado.');
    const id = crypto.randomUUID();
    const payload: PluginSandboxCall = { id, pluginId, method, ...(input !== undefined ? { input } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Tool do plugin excedeu o tempo limite no sandbox.'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { webContentsId: target.id, resolve, reject, timer });
      target.send('plugins:sandbox-call', payload);
    });
  }

  resolve(event: IpcMainInvokeEvent, input: unknown): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Resposta do sandbox inválida.');
    const value = input as Record<string, unknown>;
    if (typeof value.id !== 'string') throw new Error('ID da resposta do sandbox inválido.');
    const pending = this.pending.get(value.id);
    if (!pending) return false;
    if (event.sender.id !== pending.webContentsId) throw new Error('Resposta do sandbox veio de uma janela não autorizada.');
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (typeof value.error === 'string' && value.error) {
      pending.reject(new Error(value.error.slice(0, 2048)));
      return true;
    }
    assertSize(value.value, MAX_OUTPUT_BYTES, 'Saída da tool de plugin');
    pending.resolve(structuredClone(value.value));
    return true;
  }

  cancelAll(reason = 'Sandbox de plugins foi encerrado.'): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
