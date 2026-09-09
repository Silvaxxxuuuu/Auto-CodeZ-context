import os from 'node:os';
import fs from 'node:fs/promises';
import type { LocalHardwareSnapshot } from './local-model-runtime';

type StatFsLike = {
  bavail: number | bigint;
  bsize: number | bigint;
};

function finiteNonNegative(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function statValue(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

async function readFreeDiskBytes(probePath?: string): Promise<number | undefined> {
  if (!probePath?.trim()) return undefined;
  try {
    const stat = await fs.statfs(probePath) as StatFsLike;
    return finiteNonNegative(statValue(stat.bavail) * statValue(stat.bsize));
  } catch {
    return undefined;
  }
}

export async function collectLocalHardwareSnapshot(probePath?: string): Promise<LocalHardwareSnapshot> {
  const cpus = os.cpus();
  const cpuModel = cpus.find((cpu) => cpu.model.trim())?.model.trim();
  const freeDiskBytes = await readFreeDiskBytes(probePath);
  return {
    totalRamBytes: os.totalmem(),
    availableRamBytes: os.freemem(),
    architecture: os.arch(),
    ...(cpuModel ? { cpuModel } : {}),
    ...(freeDiskBytes !== undefined ? { freeDiskBytes } : {}),
  };
}
