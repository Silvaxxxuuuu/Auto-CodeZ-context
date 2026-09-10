import crypto from 'node:crypto';
import type { PluginJobSnapshot } from './plugin-types';

const MAX_JOBS = 256;
const MAX_ACTIVE_PER_PLUGIN = 4;
const MAX_LABEL_LENGTH = 160;
const MAX_ACTIVITY_LENGTH = 512;
const MAX_ERROR_LENGTH = 2048;

export type PluginJobContext = {
  signal: AbortSignal;
  setProgress(progress: number, activity?: string): void;
  setActivity(activity: string): void;
};

export type PluginJobTask = (context: PluginJobContext) => Promise<void>;
export type PluginJobListener = (snapshot: PluginJobSnapshot) => void;

type InternalJob = PluginJobSnapshot & {
  controller: AbortController;
};

function boundedText(value: string, maxLength: number, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} inválido.`);
  }
  return normalized;
}

function clone(job: InternalJob): PluginJobSnapshot {
  const { controller: _controller, ...snapshot } = job;
  return { ...snapshot };
}

export class PluginJobRuntime {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly listeners = new Set<PluginJobListener>();

  start(pluginId: string, label: string, task: PluginJobTask, now = Date.now()): PluginJobSnapshot {
    const normalizedPluginId = boundedText(pluginId, 128, 'Plugin');
    const normalizedLabel = boundedText(label, MAX_LABEL_LENGTH, 'Nome do job');
    const active = [...this.jobs.values()].filter((job) => job.pluginId === normalizedPluginId && (job.state === 'queued' || job.state === 'running'));
    if (active.length >= MAX_ACTIVE_PER_PLUGIN) throw new Error(`Plugin '${normalizedPluginId}' atingiu o limite de jobs simultâneos.`);

    this.prune();
    if (this.jobs.size >= MAX_JOBS) throw new Error('Limite global de jobs de plugins atingido.');

    const id = crypto.randomUUID();
    const job: InternalJob = {
      id,
      pluginId: normalizedPluginId,
      label: normalizedLabel,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
    };
    this.jobs.set(id, job);
    this.emit(job);
    void this.run(job, task);
    return clone(job);
  }

  cancel(pluginId: string, jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.pluginId !== pluginId || (job.state !== 'queued' && job.state !== 'running')) return false;
    job.controller.abort();
    job.state = 'cancelled';
    job.updatedAt = Date.now();
    this.emit(job);
    return true;
  }

  cancelPlugin(pluginId: string): number {
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (job.pluginId === pluginId && this.cancel(pluginId, job.id)) cancelled += 1;
    }
    return cancelled;
  }

  get(pluginId: string, jobId: string): PluginJobSnapshot | undefined {
    const job = this.jobs.get(jobId);
    return job?.pluginId === pluginId ? clone(job) : undefined;
  }

  list(pluginId?: string): PluginJobSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => !pluginId || job.pluginId === pluginId)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .map(clone);
  }

  subscribe(listener: PluginJobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async run(job: InternalJob, task: PluginJobTask): Promise<void> {
    if (job.state === 'cancelled') return;
    job.state = 'running';
    job.updatedAt = Date.now();
    this.emit(job);

    const context: PluginJobContext = {
      signal: job.controller.signal,
      setProgress: (progress, activity) => {
        if (job.state !== 'running') return;
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('Progresso de job inválido.');
        job.progress = progress;
        if (activity !== undefined) job.activity = boundedText(activity, MAX_ACTIVITY_LENGTH, 'Atividade do job');
        job.updatedAt = Date.now();
        this.emit(job);
      },
      setActivity: (activity) => {
        if (job.state !== 'running') return;
        job.activity = boundedText(activity, MAX_ACTIVITY_LENGTH, 'Atividade do job');
        job.updatedAt = Date.now();
        this.emit(job);
      },
    };

    try {
      await task(context);
      if (job.state === 'cancelled' || job.controller.signal.aborted) return;
      job.state = 'completed';
      job.progress = 1;
      job.updatedAt = Date.now();
      this.emit(job);
    } catch (error) {
      if (job.controller.signal.aborted || job.state === 'cancelled') {
        if (job.state !== 'cancelled') {
          job.state = 'cancelled';
          job.updatedAt = Date.now();
          this.emit(job);
        }
        return;
      }
      job.state = 'failed';
      job.error = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
      job.updatedAt = Date.now();
      this.emit(job);
    }
  }

  private emit(job: InternalJob): void {
    const snapshot = clone(job);
    for (const listener of this.listeners) {
      try {
        listener({ ...snapshot });
      } catch {
      }
    }
  }

  private prune(): void {
    const settled = [...this.jobs.values()]
      .filter((job) => job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.jobs.size >= MAX_JOBS && settled.length) {
      const oldest = settled.shift();
      if (oldest) this.jobs.delete(oldest.id);
    }
  }
}
