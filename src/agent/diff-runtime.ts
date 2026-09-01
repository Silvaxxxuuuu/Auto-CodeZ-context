import type { FileDiff } from '../ai/types';

const MAX_EXACT_COMPARISON_CELLS = 4_000_000;

function lineCounts(before: string, after: string): { addedLines: number; removedLines: number } {
  const oldLines = before ? before.split(/\r?\n/) : [];
  const newLines = after ? after.split(/\r?\n/) : [];

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const oldLength = oldEnd - prefix;
  const newLength = newEnd - prefix;
  if (oldLength === 0) return { addedLines: newLength, removedLines: 0 };
  if (newLength === 0) return { addedLines: 0, removedLines: oldLength };

  if (oldLength * newLength > MAX_EXACT_COMPARISON_CELLS) {
    return { addedLines: newLength, removedLines: oldLength };
  }

  const oldSlice = oldLines.slice(prefix, oldEnd);
  const newSlice = newLines.slice(prefix, newEnd);
  const cols = oldSlice.length + 1;
  let previous = new Uint32Array(cols);

  for (let row = 1; row <= newSlice.length; row += 1) {
    const current = new Uint32Array(cols);
    for (let col = 1; col < cols; col += 1) {
      current[col] = newSlice[row - 1] === oldSlice[col - 1]
        ? previous[col - 1] + 1
        : Math.max(previous[col], current[col - 1]);
    }
    previous = current;
  }

  const common = previous[cols - 1];
  return { addedLines: newLength - common, removedLines: oldLength - common };
}

export class DiffRuntime {
  create(path: string, type: FileDiff['type'], before: string, after: string, renamedFrom?: string): FileDiff {
    const counts = lineCounts(before, after);
    return { path, type, before, after, ...counts, ...(renamedFrom ? { renamedFrom } : {}) };
  }
}
