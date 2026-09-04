const ANSI_PATTERN = /\x1b\[([0-9;]*)m/g;
const CONTROL_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[\x20-\x2f]*[@-~]/g;

const foreground: Record<number, string> = {
  30: '#7b8492', 31: '#e06c75', 32: '#98c379', 33: '#d19a66', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#d7dce2',
  90: '#9aa3af', 91: '#f07b84', 92: '#a8d78b', 93: '#e2b37b', 94: '#79b8ff', 95: '#d990ee', 96: '#71c7d1', 97: '#f2f5f8',
};

const background: Record<number, string> = {
  40: '#1a1d22', 41: '#5a262b', 42: '#2f4c2c', 43: '#584327', 44: '#24496b', 45: '#4c3157', 46: '#27515a', 47: '#d7dce2',
  100: '#363b43', 101: '#713139', 102: '#3d6038', 103: '#705735', 104: '#2e5d88', 105: '#613f70', 106: '#326771', 107: '#f2f5f8',
};

type AnsiState = {
  color?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function styleFor(state: AnsiState): string {
  const styles: string[] = [];
  if (state.color) styles.push(`color:${state.color}`);
  if (state.background) styles.push(`background:${state.background}`);
  if (state.bold) styles.push('font-weight:700');
  if (state.dim) styles.push('opacity:.72');
  if (state.italic) styles.push('font-style:italic');
  if (state.underline) styles.push('text-decoration:underline');
  return styles.join(';');
}

function reset(state: AnsiState): void {
  delete state.color;
  delete state.background;
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
}

function applyCodes(state: AnsiState, codes: number[]): void {
  if (!codes.length) codes = [0];
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) reset(state);
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 39) delete state.color;
    else if (code === 49) delete state.background;
    else if (foreground[code]) state.color = foreground[code];
    else if (background[code]) state.background = background[code];
    else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes.length > index + 4) {
      const r = Math.max(0, Math.min(255, codes[index + 2]));
      const g = Math.max(0, Math.min(255, codes[index + 3]));
      const b = Math.max(0, Math.min(255, codes[index + 4]));
      const value = `rgb(${r},${g},${b})`;
      if (code === 38) state.color = value;
      else state.background = value;
      index += 4;
    }
  }
}

function ansiToHtml(raw: string): string {
  const source = raw.replace(CONTROL_PATTERN, (sequence) => sequence.endsWith('m') ? sequence : '');
  const state: AnsiState = { bold: false, dim: false, italic: false, underline: false };
  let cursor = 0;
  let html = '';

  ANSI_PATTERN.lastIndex = 0;
  for (let match = ANSI_PATTERN.exec(source); match; match = ANSI_PATTERN.exec(source)) {
    const chunk = source.slice(cursor, match.index);
    if (chunk) {
      const style = styleFor(state);
      html += style ? `<span style="${style}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
    }
    const codes = match[1] ? match[1].split(';').map((value) => Number.parseInt(value || '0', 10)) : [0];
    applyCodes(state, codes.filter(Number.isFinite));
    cursor = match.index + match[0].length;
  }

  const tail = source.slice(cursor);
  if (tail) {
    const style = styleFor(state);
    html += style ? `<span style="${style}">${escapeHtml(tail)}</span>` : escapeHtml(tail);
  }
  return html;
}

function enhance(output: HTMLElement): void {
  if (output.dataset.ansiRendering === 'true') return;
  const raw = output.textContent || '';
  if (!raw.includes('\x1b')) return;
  output.dataset.ansiRendering = 'true';
  try {
    output.innerHTML = ansiToHtml(raw);
  } finally {
    delete output.dataset.ansiRendering;
  }
}

function install(): void {
  const output = document.querySelector<HTMLElement>('#terminal-output');
  if (!output || output.dataset.ansiObserver === 'true') return;
  output.dataset.ansiObserver = 'true';
  const observer = new MutationObserver(() => enhance(output));
  observer.observe(output, { childList: true, subtree: true, characterData: true });
  enhance(output);
}

const style = document.createElement('style');
style.id = 'auto-codez-terminal-visual-ui';
style.textContent = '.terminal-output{font-variant-ligatures:none;tab-size:4}.terminal-output span{white-space:pre-wrap}';
document.head.appendChild(style);

install();
const observer = new MutationObserver(() => {
  install();
  if (document.querySelector('#terminal-output')) observer.disconnect();
});
if (!document.querySelector('#terminal-output')) observer.observe(document.body, { childList: true, subtree: true });
