import type { AIModel, ProviderId } from './types';

function modelScore(model: AIModel, index: number): number {
  const id = `${model.id} ${model.name}`.toLowerCase();
  let score = 0;
  if (model.capabilities.includes('text')) score += 100;
  if (model.capabilities.includes('tools')) score += 80;
  if (model.capabilities.includes('streaming')) score += 40;
  if (model.capabilities.includes('reasoning')) score += 20;
  if (model.capabilities.includes('vision')) score += 10;
  if (/(?:^|[-_.])(?:preview|experimental|exp|beta|alpha)(?:[-_.]|$)/i.test(id)) score -= 35;
  if (/(?:deprecated|legacy|old)/i.test(id)) score -= 100;
  if (/(?:lite|nano|micro|tiny)/i.test(id)) score -= 25;
  if (/(?:mini|haiku)/i.test(id)) score -= 10;
  const version = id.match(/(?:^|[-_.])(?:gpt|claude|gemini)?[-_.]?(\d+(?:\.\d+)?)/i)?.[1];
  if (version) score += Number(version) * 2;
  return score - index / 1000;
}

export function selectDefaultModel(providerId: ProviderId, models: AIModel[]): string | undefined {
  void providerId;
  return models.reduce<{ model?: AIModel; score: number }>((best, candidate, index) => {
    const score = modelScore(candidate, index);
    return score > best.score ? { model: candidate, score } : best;
  }, { score: Number.NEGATIVE_INFINITY }).model?.id;
}
