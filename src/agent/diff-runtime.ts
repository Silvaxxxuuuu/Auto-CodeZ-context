import type { FileDiff } from '../ai/types';

function lineCounts(before: string, after: string): { addedLines: number; removedLines: number } {
  const oldLines = before ? before.split(/\r?\n/) : [];
  const newLines = after ? after.split(/\r?\n/) : [];
  const rows = newLines.length + 1;
  const cols = oldLines.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols));

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      lcs[row][col] = newLines[row - 1] === oldLines[col - 1]
        ? lcs[row - 1][col - 1] + 1
        : Math.max(lcs[row - 1][col], lcs[row][col - 1]);
    }
  }

  const common = lcs[rows - 1][cols - 1];
  return { addedLines: newLines.length - common, removedLines: oldLines.length - common };
}

export class DiffRuntime {
  create(path: string, type: FileDiff['type'], before: string, after: string, renamedFrom?: string): FileDiff {
    const counts = lineCounts(before, after);
    return { path, type, before, after, ...counts, ...(renamedFrom ? { renamedFrom } : {}) };
  }
}
