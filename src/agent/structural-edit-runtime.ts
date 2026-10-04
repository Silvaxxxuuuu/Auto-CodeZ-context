export type StructuralSymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'property' | 'unknown';

export interface StructuralSymbolQuery {
  name: string;
  kind?: StructuralSymbolKind;
}

export interface StructuralSymbolMatch {
  name: string;
  kind: StructuralSymbolKind;
  startOffset: number;
  endOffset: number;
  startLine?: number;
  endLine?: number;
}

export interface StructuralReplacementRange {
  startOffset: number;
  endOffset: number;
}

export interface StructuralSymbolLocator {
  readonly id: string;
  supports(filePath: string): boolean;
  locate(filePath: string, content: string, query: StructuralSymbolQuery): Promise<StructuralSymbolMatch[]> | StructuralSymbolMatch[];
  validateReplacement(filePath: string, content: string, query: StructuralSymbolQuery, replacementRange: StructuralReplacementRange): Promise<void> | void;
}

export interface StructuralReadResult {
  content: string;
  match: StructuralSymbolMatch;
  locatorId: string;
}

export interface StructuralReplacementResult {
  before: string;
  after: string;
  match: StructuralSymbolMatch;
  locatorId: string;
}

function requireQuery(query: StructuralSymbolQuery): StructuralSymbolQuery {
  if (!query || typeof query.name !== 'string' || !query.name.trim()) throw new Error('O nome do símbolo deve ser um texto não vazio.');
  return { name: query.name.trim(), kind: query.kind };
}

function validateMatch(match: StructuralSymbolMatch, content: string): void {
  if (!match || typeof match.name !== 'string' || !match.name.trim()) throw new Error('O localizador retornou um símbolo inválido.');
  if (!Number.isInteger(match.startOffset) || !Number.isInteger(match.endOffset)) throw new Error('O localizador retornou offsets não inteiros.');
  if (match.startOffset < 0 || match.endOffset <= match.startOffset || match.endOffset > content.length) throw new Error('O localizador retornou um intervalo de símbolo inválido.');
}

export class StructuralEditRuntime {
  constructor(private readonly locators: readonly StructuralSymbolLocator[]) {}

  listLocatorIds(): string[] {
    return this.locators.map((locator) => locator.id);
  }

  async readSymbol(filePath: string, content: string, query: StructuralSymbolQuery): Promise<StructuralReadResult> {
    const resolved = await this.resolveSymbol(filePath, content, query);
    return {
      content: content.slice(resolved.match.startOffset, resolved.match.endOffset),
      match: { ...resolved.match },
      locatorId: resolved.locator.id,
    };
  }

  async replaceSymbol(filePath: string, content: string, query: StructuralSymbolQuery, replacement: string): Promise<StructuralReplacementResult> {
    if (typeof replacement !== 'string') throw new Error('O conteúdo de substituição deve ser texto.');

    const resolved = await this.resolveSymbol(filePath, content, query);
    const after = content.slice(0, resolved.match.startOffset) + replacement + content.slice(resolved.match.endOffset);
    if (after === content) throw new Error('A substituição estrutural não produziria nenhuma alteração.');

    await resolved.locator.validateReplacement(filePath, after, resolved.query, {
      startOffset: resolved.match.startOffset,
      endOffset: resolved.match.startOffset + replacement.length,
    });

    return { before: content, after, match: { ...resolved.match }, locatorId: resolved.locator.id };
  }

  private async resolveSymbol(filePath: string, content: string, query: StructuralSymbolQuery): Promise<{ locator: StructuralSymbolLocator; query: StructuralSymbolQuery; match: StructuralSymbolMatch }> {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('O caminho do arquivo deve ser informado.');
    if (typeof content !== 'string') throw new Error('O conteúdo atual do arquivo deve ser texto.');

    const normalizedQuery = requireQuery(query);
    const locator = this.locators.find((candidate) => candidate.supports(filePath));
    if (!locator) throw new Error(`Nenhum localizador estrutural suporta '${filePath}'.`);

    const matches = await locator.locate(filePath, content, normalizedQuery);
    if (!Array.isArray(matches)) throw new Error(`O localizador '${locator.id}' retornou uma resposta inválida.`);
    if (matches.length === 0) throw new Error(`O símbolo '${normalizedQuery.name}' não foi encontrado.`);
    if (matches.length > 1) throw new Error(`O símbolo '${normalizedQuery.name}' é ambíguo: ${matches.length} correspondências encontradas.`);

    const match = matches[0];
    validateMatch(match, content);
    if (match.name !== normalizedQuery.name) throw new Error(`O localizador retornou '${match.name}' quando '${normalizedQuery.name}' foi solicitado.`);
    if (normalizedQuery.kind && match.kind !== normalizedQuery.kind) throw new Error(`O símbolo '${normalizedQuery.name}' foi encontrado como '${match.kind}', não como '${normalizedQuery.kind}'.`);

    return { locator, query: normalizedQuery, match };
  }
}
