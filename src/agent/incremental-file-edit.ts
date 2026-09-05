import type { ToolName } from '../ai/types';

export type IncrementalEditToolName = Extract<ToolName, 'replace_range' | 'insert_before' | 'insert_after'>;

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} deve ser um inteiro maior ou igual a 1.`);
  return Number(value);
}

function requireContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error("Parâmetro 'content' deve ser texto.");
  return value;
}

function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(content: string): { lines: string[]; eol: '\r\n' | '\n'; trailingEol: boolean } {
  const eol = detectEol(content);
  const trailingEol = content.endsWith('\n');
  const lines = content.split(/\r?\n/);
  if (trailingEol) lines.pop();
  return { lines: lines.length ? lines : [''], eol, trailingEol };
}

function splitInsertedContent(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines.length ? lines : [''];
}

function joinLines(lines: string[], eol: '\r\n' | '\n', trailingEol: boolean): string {
  return lines.join(eol) + (trailingEol ? eol : '');
}

export function applyIncrementalEdit(name: IncrementalEditToolName, input: Record<string, unknown>, before: string): string {
  const { lines, eol, trailingEol } = splitLines(before);
  const contentLines = splitInsertedContent(requireContent(input.content));

  if (name === 'replace_range') {
    const startLine = requirePositiveInteger(input.startLine, 'startLine');
    const endLine = requirePositiveInteger(input.endLine, 'endLine');
    if (startLine > endLine) throw new Error('startLine não pode ser maior que endLine.');
    if (endLine > lines.length) throw new Error(`endLine excede o número de linhas do arquivo (${lines.length}).`);
    lines.splice(startLine - 1, endLine - startLine + 1, ...contentLines);
    return joinLines(lines, eol, trailingEol);
  }

  const line = requirePositiveInteger(input.line, 'line');
  if (line > lines.length) throw new Error(`line excede o número de linhas do arquivo (${lines.length}).`);
  const index = name === 'insert_before' ? line - 1 : line;
  lines.splice(index, 0, ...contentLines);
  return joinLines(lines, eol, trailingEol);
}
