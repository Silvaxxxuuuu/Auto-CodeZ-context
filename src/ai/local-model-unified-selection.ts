import type { LocalModelCompatibility, LocalModelCompatibilityResult } from './local-model-runtime';
import type { ManagedLocalRuntimeInfo } from './local-model-manager';

export type UnifiedLocalModelInput = {
  id: string;
  name: string;
  runtimeId: string;
  installed: boolean;
  installing?: boolean;
  recommended?: boolean;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  capabilities?: string[];
  description?: string;
  compatibility: LocalModelCompatibilityResult;
};

export type UnifiedLocalModelVariant = UnifiedLocalModelInput & {
  key: string;
  runtime?: ManagedLocalRuntimeInfo;
};

export type UnifiedLocalModelChoice = {
  id: string;
  name: string;
  variants: UnifiedLocalModelVariant[];
  selected: UnifiedLocalModelVariant;
  installed: boolean;
  installing: boolean;
  recommended: boolean;
};

const RUNTIME_PRIORITY = new Map([
  ['auto-codez-local', 0],
  ['ollama', 10],
  ['lm-studio', 20],
]);

function normalized(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function compatibilityRank(level: LocalModelCompatibility): number {
  if (level === 'excellent') return 4;
  if (level === 'compatible') return 3;
  if (level === 'limit') return 2;
  return 1;
}

function runtimePriority(runtimeId: string): number {
  return RUNTIME_PRIORITY.get(runtimeId) ?? 100;
}

function logicalModelId(model: UnifiedLocalModelInput): string {
  const family = normalized(model.family);
  const parameters = normalized(model.parameterSize);
  if (family && parameters) return `${family}:${parameters}`;
  const name = normalized(model.name.replace(/\s*[·|-]\s*q\d[^·|-]*$/i, ''));
  return name || `${normalized(model.runtimeId)}:${normalized(model.id)}`;
}

function displayName(model: UnifiedLocalModelInput): string {
  const trimmed = model.name.replace(/\s*·\s*Q\d[^·]*$/i, '').trim();
  return trimmed || model.name;
}

function mergeRuntimeModel(left: UnifiedLocalModelInput, right: UnifiedLocalModelInput): UnifiedLocalModelInput {
  const installed = left.installed || right.installed;
  const primary = right.installed && !left.installed ? right : left;
  const secondary = primary === left ? right : left;
  return {
    ...secondary,
    ...primary,
    installed,
    installing: Boolean(left.installing || right.installing),
    recommended: Boolean(left.recommended || right.recommended),
    capabilities: [...new Set([...(left.capabilities ?? []), ...(right.capabilities ?? [])])],
  };
}

function chooseVariant(variants: UnifiedLocalModelVariant[]): UnifiedLocalModelVariant {
  return [...variants].sort((left, right) => {
    if (left.installing !== right.installing) return left.installing ? -1 : 1;
    if (left.installed !== right.installed) return left.installed ? -1 : 1;
    if (left.runtime?.available !== right.runtime?.available) return left.runtime?.available ? -1 : 1;
    const compatibility = compatibilityRank(right.compatibility.level) - compatibilityRank(left.compatibility.level);
    if (compatibility) return compatibility;
    if (left.runtime?.operations.install !== right.runtime?.operations.install) return left.runtime?.operations.install ? -1 : 1;
    const priority = runtimePriority(left.runtimeId) - runtimePriority(right.runtimeId);
    if (priority) return priority;
    return left.id.localeCompare(right.id);
  })[0]!;
}

export function buildUnifiedLocalModelChoices(
  models: UnifiedLocalModelInput[],
  runtimes: ManagedLocalRuntimeInfo[],
): UnifiedLocalModelChoice[] {
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const exact = new Map<string, UnifiedLocalModelInput>();
  for (const model of models) {
    const key = `${model.runtimeId}\u0000${model.id}`;
    const existing = exact.get(key);
    exact.set(key, existing ? mergeRuntimeModel(existing, model) : { ...model, capabilities: [...(model.capabilities ?? [])] });
  }

  const groups = new Map<string, UnifiedLocalModelVariant[]>();
  for (const model of exact.values()) {
    const id = logicalModelId(model);
    const variants = groups.get(id) ?? [];
    variants.push({
      ...model,
      key: `${model.runtimeId}::${model.id}`,
      runtime: runtimeMap.get(model.runtimeId),
    });
    groups.set(id, variants);
  }

  return [...groups.entries()].map(([id, variants]) => {
    const selected = chooseVariant(variants);
    return {
      id,
      name: displayName(selected),
      variants: variants.sort((left, right) => runtimePriority(left.runtimeId) - runtimePriority(right.runtimeId)),
      selected,
      installed: variants.some((variant) => variant.installed),
      installing: variants.some((variant) => variant.installing),
      recommended: variants.some((variant) => variant.recommended),
    };
  }).sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    if (left.installed !== right.installed) return left.installed ? -1 : 1;
    const compatibility = compatibilityRank(right.selected.compatibility.level) - compatibilityRank(left.selected.compatibility.level);
    if (compatibility) return compatibility;
    return left.name.localeCompare(right.name);
  });
}

export function findUnifiedLocalChoice(
  choices: UnifiedLocalModelChoice[],
  providerId: string,
  modelId: string,
): UnifiedLocalModelChoice | undefined {
  return choices.find((choice) => choice.variants.some((variant) => variant.runtimeId === providerId && variant.id === modelId));
}
