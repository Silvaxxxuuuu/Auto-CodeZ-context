export type LocalModelRuntimeState = 'runtime-missing' | 'installed' | 'installable' | 'installing' | 'ready' | 'incompatible';
export type LocalModelCompatibility = 'excellent' | 'compatible' | 'limit' | 'blocked';

export type LocalHardwareSnapshot = {
  totalRamBytes: number;
  availableRamBytes: number;
  freeDiskBytes?: number;
  totalVramBytes?: number;
  availableVramBytes?: number;
  architecture?: string;
  cpuModel?: string;
  gpuName?: string;
};

export type LocalModelRequirements = {
  downloadBytes?: number;
  estimatedRamBytes?: number;
  estimatedVramBytes?: number;
  minimumFreeDiskBytes?: number;
};

export type LocalModelCompatibilityResult = {
  level: LocalModelCompatibility;
  reasons: string[];
  requirements: LocalModelRequirements;
};

export type LocalModelDescriptor = {
  id: string;
  name: string;
  runtimeId: string;
  installed: boolean;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  capabilities?: string[];
  contextWindow?: number;
};

export type LocalModelInstallProgress = {
  runtimeId: string;
  modelId: string;
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
  digest?: string;
  done: boolean;
};

export type LocalModelRuntimeInfo = {
  id: string;
  displayName: string;
  available: boolean;
  endpoint?: string;
};

export interface LocalModelRuntimeAdapter {
  readonly id: string;
  readonly displayName: string;
  getInfo(): Promise<LocalModelRuntimeInfo>;
  listInstalled(): Promise<LocalModelDescriptor[]>;
  install(modelId: string, signal?: AbortSignal): AsyncGenerator<LocalModelInstallProgress>;
}

const GIB = 1024 ** 3;
const SYSTEM_RAM_RESERVE_BYTES = 3 * GIB;
const DISK_RESERVE_BYTES = 2 * GIB;

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function estimateQuantizedModelRam(sizeBytes: number | undefined): number | undefined {
  const size = finitePositive(sizeBytes);
  if (!size) return undefined;
  return Math.ceil(size * 1.25 + 512 * 1024 ** 2);
}

export function evaluateLocalModelCompatibility(
  hardware: LocalHardwareSnapshot,
  requirements: LocalModelRequirements,
): LocalModelCompatibilityResult {
  const estimatedRamBytes = finitePositive(requirements.estimatedRamBytes);
  const estimatedVramBytes = finitePositive(requirements.estimatedVramBytes);
  const downloadBytes = finitePositive(requirements.downloadBytes);
  const minimumFreeDiskBytes = finitePositive(requirements.minimumFreeDiskBytes)
    ?? (downloadBytes ? downloadBytes + DISK_RESERVE_BYTES : undefined);
  const normalized: LocalModelRequirements = {
    ...requirements,
    ...(estimatedRamBytes ? { estimatedRamBytes } : {}),
    ...(estimatedVramBytes ? { estimatedVramBytes } : {}),
    ...(minimumFreeDiskBytes ? { minimumFreeDiskBytes } : {}),
  };
  const reasons: string[] = [];

  if (minimumFreeDiskBytes && hardware.freeDiskBytes !== undefined && hardware.freeDiskBytes < minimumFreeDiskBytes) {
    reasons.push('Espaço livre em disco insuficiente para o download com margem de segurança.');
    return { level: 'blocked', reasons, requirements: normalized };
  }

  if (estimatedRamBytes) {
    const safeTotalRam = Math.max(0, hardware.totalRamBytes - SYSTEM_RAM_RESERVE_BYTES);
    if (estimatedRamBytes > safeTotalRam) {
      reasons.push('A memória estimada do modelo excede a RAM total reservando espaço para o sistema.');
      return { level: 'blocked', reasons, requirements: normalized };
    }
    if (estimatedRamBytes > hardware.availableRamBytes) {
      reasons.push('A RAM disponível agora está abaixo da memória estimada para o modelo.');
      return { level: 'limit', reasons, requirements: normalized };
    }
    const headroom = hardware.availableRamBytes - estimatedRamBytes;
    if (headroom < 2 * GIB) {
      reasons.push('O modelo cabe na RAM disponível, mas deixa pouca margem para o sistema e outras tarefas.');
      return { level: 'limit', reasons, requirements: normalized };
    }
  }

  if (estimatedVramBytes && hardware.totalVramBytes !== undefined && estimatedVramBytes > hardware.totalVramBytes) {
    reasons.push('A VRAM estimada excede a VRAM disponível na GPU, então o runtime precisará usar RAM ou offload parcial.');
    return { level: 'compatible', reasons, requirements: normalized };
  }

  if (estimatedRamBytes && estimatedRamBytes > hardware.totalRamBytes * 0.5) {
    reasons.push('O modelo usa uma parcela relevante da RAM total, mas mantém margem operacional.');
    return { level: 'compatible', reasons, requirements: normalized };
  }

  reasons.push('Há margem de memória e armazenamento suficiente para a estimativa atual.');
  return { level: 'excellent', reasons, requirements: normalized };
}
