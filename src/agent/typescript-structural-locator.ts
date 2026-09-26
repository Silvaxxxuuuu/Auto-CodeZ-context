import path from 'node:path';
import ts from 'typescript';
import type { StructuralReplacementRange, StructuralSymbolKind, StructuralSymbolLocator, StructuralSymbolMatch, StructuralSymbolQuery } from './structural-edit-runtime';

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

type ParsedSourceFile = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };

function scriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function parseSourceFile(filePath: string, content: string): ParsedSourceFile {
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind(filePath)) as ParsedSourceFile;
}

function identifierText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

function symbolKind(node: ts.Node): StructuralSymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  return undefined;
}

function symbolName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name?.text;
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return identifierText(node.name);
  return undefined;
}

function toMatch(sourceFile: ts.SourceFile, node: ts.Node, name: string, kind: StructuralSymbolKind): StructuralSymbolMatch {
  const startOffset = node.getStart(sourceFile, false);
  const endOffset = node.getEnd();
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(Math.max(startOffset, endOffset - 1));
  return {
    name,
    kind,
    startOffset,
    endOffset,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function locateInSourceFile(sourceFile: ts.SourceFile, query: StructuralSymbolQuery): StructuralSymbolMatch[] {
  const matches: StructuralSymbolMatch[] = [];

  const visit = (node: ts.Node): void => {
    const kind = symbolKind(node);
    if (kind) {
      const name = symbolName(node);
      if (name === query.name && (!query.kind || query.kind === kind)) matches.push(toMatch(sourceFile, node, name, kind));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return matches;
}

function firstParseError(sourceFile: ParsedSourceFile): string | undefined {
  const diagnostic = sourceFile.parseDiagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  return diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') : undefined;
}

export class TypeScriptStructuralLocator implements StructuralSymbolLocator {
  readonly id = 'typescript';

  supports(filePath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  locate(filePath: string, content: string, query: StructuralSymbolQuery): StructuralSymbolMatch[] {
    if (!this.supports(filePath)) return [];
    return locateInSourceFile(parseSourceFile(filePath, content), query);
  }

  validateReplacement(filePath: string, content: string, query: StructuralSymbolQuery, replacementRange: StructuralReplacementRange): void {
    const sourceFile = parseSourceFile(filePath, content);
    const parseError = firstParseError(sourceFile);
    if (parseError) throw new Error(`A substituição deixaria o arquivo com sintaxe inválida: ${parseError}`);

    const matches = locateInSourceFile(sourceFile, query);
    if (matches.length === 0) throw new Error(`A substituição precisa preservar o símbolo '${query.name}' com o mesmo tipo solicitado.`);
    if (matches.length > 1) throw new Error(`A substituição criaria ambiguidade para o símbolo '${query.name}': ${matches.length} correspondências encontradas.`);

    const match = matches[0];
    if (match.startOffset < replacementRange.startOffset || match.endOffset > replacementRange.endOffset) {
      throw new Error(`A substituição precisa conter integralmente a nova declaração de '${query.name}'.`);
    }

    const leading = content.slice(replacementRange.startOffset, match.startOffset);
    const trailing = content.slice(match.endOffset, replacementRange.endOffset);
    if (leading.trim() || trailing.trim()) throw new Error('O conteúdo de substituição deve conter apenas uma declaração estrutural e espaços em branco opcionais.');
  }
}
