import type { LocalModelDescriptor } from './local-model-runtime';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export type LocalModelCatalogEntry = LocalModelDescriptor & {
  installed: false;
  description: string;
  recommendedFor: string[];
  source: 'ollama-library' | 'lmstudio-community';
  install?: {
    source: string;
    quantization?: string;
  };
};

const catalog: LocalModelCatalogEntry[] = [
  {
    id: 'qwen3:0.6b',
    name: 'Qwen 3 0.6B',
    runtimeId: 'ollama',
    installed: false,
    sizeBytes: 523 * MB,
    parameterSize: '0.6B',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 40_000,
    description: 'Modelo muito leve para máquinas com pouca memória e tarefas rápidas.',
    recommendedFor: ['chat rápido', 'tarefas leves', 'hardware limitado'],
    source: 'ollama-library',
  },
  {
    id: 'qwen3:1.7b',
    name: 'Qwen 3 1.7B',
    runtimeId: 'ollama',
    installed: false,
    sizeBytes: 1.4 * GB,
    parameterSize: '1.7B',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 40_000,
    description: 'Opção compacta com tools e raciocínio para uso local cotidiano.',
    recommendedFor: ['chat', 'código leve', 'agente local'],
    source: 'ollama-library',
  },
  {
    id: 'qwen3:4b',
    name: 'Qwen 3 4B',
    runtimeId: 'ollama',
    installed: false,
    sizeBytes: 2.5 * GB,
    parameterSize: '4B',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 256_000,
    description: 'Equilíbrio entre qualidade, contexto longo e custo local.',
    recommendedFor: ['código', 'agente', 'contexto longo'],
    source: 'ollama-library',
  },
  {
    id: 'qwen3:8b',
    name: 'Qwen 3 8B',
    runtimeId: 'ollama',
    installed: false,
    sizeBytes: 5.2 * GB,
    parameterSize: '8B',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 40_000,
    description: 'Modelo local mais pesado para tarefas de código e raciocínio com maior qualidade.',
    recommendedFor: ['código', 'raciocínio', 'agente'],
    source: 'ollama-library',
  },
  {
    id: 'gemma3:1b',
    name: 'Gemma 3 1B',
    runtimeId: 'ollama',
    installed: false,
    sizeBytes: 815 * MB,
    parameterSize: '1B',
    family: 'gemma3',
    capabilities: [],
    contextWindow: 32_000,
    description: 'Modelo compacto para texto e conversas locais de baixo custo.',
    recommendedFor: ['texto', 'resumo', 'hardware limitado'],
    source: 'ollama-library',
  },
  {
    id: 'gemma3:4b',
    name: 'Gemma 3 4B',
    runtimeId: 'ollama',
    installed: false,
    sizeBytes: 3.3 * GB,
    parameterSize: '4B',
    family: 'gemma3',
    capabilities: ['vision'],
    contextWindow: 128_000,
    description: 'Modelo multimodal local para texto e imagem com contexto amplo.',
    recommendedFor: ['visão', 'documentos', 'chat multimodal'],
    source: 'ollama-library',
  },
  {
    id: 'qwen3-0.6b-q4-k-m',
    name: 'Qwen 3 0.6B · Q4_K_M',
    runtimeId: 'lm-studio',
    installed: false,
    sizeBytes: 484 * MB,
    parameterSize: '0.6B',
    quantization: 'Q4_K_M',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 40_000,
    description: 'Qwen 3 compacto empacotado pela comunidade oficial do LM Studio.',
    recommendedFor: ['chat rápido', 'tarefas leves', 'hardware limitado'],
    source: 'lmstudio-community',
    install: {
      source: 'https://huggingface.co/lmstudio-community/Qwen3-0.6B-GGUF',
      quantization: 'Q4_K_M',
    },
  },
  {
    id: 'qwen3-1.7b-q4-k-m',
    name: 'Qwen 3 1.7B · Q4_K_M',
    runtimeId: 'lm-studio',
    installed: false,
    sizeBytes: 1.282 * GB,
    parameterSize: '1.7B',
    quantization: 'Q4_K_M',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 40_000,
    description: 'Qwen 3 compacto para agentes e código leve no LM Studio.',
    recommendedFor: ['chat', 'código leve', 'agente local'],
    source: 'lmstudio-community',
    install: {
      source: 'https://huggingface.co/lmstudio-community/Qwen3-1.7B-GGUF',
      quantization: 'Q4_K_M',
    },
  },
  {
    id: 'qwen3-4b-q4-k-m',
    name: 'Qwen 3 4B · Q4_K_M',
    runtimeId: 'lm-studio',
    installed: false,
    sizeBytes: 2.5 * GB,
    parameterSize: '4B',
    quantization: 'Q4_K_M',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 256_000,
    description: 'Equilíbrio de qualidade e custo para código e tarefas de agente no LM Studio.',
    recommendedFor: ['código', 'agente', 'contexto longo'],
    source: 'lmstudio-community',
    install: {
      source: 'https://huggingface.co/lmstudio-community/Qwen3-4B-GGUF',
      quantization: 'Q4_K_M',
    },
  },
  {
    id: 'qwen3-8b-q4-k-m',
    name: 'Qwen 3 8B · Q4_K_M',
    runtimeId: 'lm-studio',
    installed: false,
    sizeBytes: 5.03 * GB,
    parameterSize: '8B',
    quantization: 'Q4_K_M',
    family: 'qwen3',
    capabilities: ['tools', 'reasoning'],
    contextWindow: 40_000,
    description: 'Opção mais pesada da seleção Qwen 3 para maior qualidade local no LM Studio.',
    recommendedFor: ['código', 'raciocínio', 'agente'],
    source: 'lmstudio-community',
    install: {
      source: 'https://huggingface.co/lmstudio-community/Qwen3-8B-GGUF',
      quantization: 'Q4_K_M',
    },
  },
];

export function listLocalModelCatalog(runtimeId?: string): LocalModelCatalogEntry[] {
  return catalog
    .filter((model) => runtimeId === undefined || model.runtimeId === runtimeId)
    .map((model) => ({
      ...model,
      capabilities: [...(model.capabilities ?? [])],
      recommendedFor: [...model.recommendedFor],
      ...(model.install ? { install: { ...model.install } } : {}),
    }));
}

export function getLocalModelCatalogEntry(runtimeId: string, modelId: string): LocalModelCatalogEntry | undefined {
  return listLocalModelCatalog(runtimeId).find((model) => model.id === modelId);
}
