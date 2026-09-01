import type { IntelligenceLevel } from '../ai/types';

export interface IntelligenceProfile {
  level: IntelligenceLevel;
  label: string;
  description: string;
}

export const intelligenceProfiles: IntelligenceProfile[] = [
  { level: 'low', label: 'Baixo', description: 'Respostas rápidas e menor uso de recursos.' },
  { level: 'normal', label: 'Normal', description: 'Equilíbrio entre qualidade, velocidade e custo.' },
  { level: 'high', label: 'Alto', description: 'Mais esforço de raciocínio e contexto quando disponível.' },
  { level: 'maximum', label: 'Máximo', description: 'Maior orçamento de raciocínio disponível no modelo.' },
];
