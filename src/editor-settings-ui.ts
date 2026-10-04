import { APP_PREFERENCES_EVENT, getAppPreferences, updateAppPreferences, type AppPreferences, type EditorFontFamily, type EditorTabSize } from './app-preferences';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function row(label: string, description: string, control: string): string {
  return `<div class="settings-row"><div class="settings-row-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(description)}</span></div><div class="settings-row-value">${control}</div></div>`;
}

function badge(value: string, tone = ''): string {
  return `<span class="settings-value-badge${tone ? ` ${tone}` : ''}">${escapeHtml(value)}</span>`;
}

function selectControl(name: string, value: string, options: Array<[string, string]>): string {
  return `<select class="settings-select" data-settings-control="${name}">${options.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
}

function toggleControl(name: string, checked: boolean): string {
  return `<label class="settings-toggle"><input type="checkbox" data-settings-control="${name}" ${checked ? 'checked' : ''}><span aria-hidden="true"></span><strong>${checked ? 'Ativado' : 'Desativado'}</strong></label>`;
}

function editorUpdate(update: Partial<AppPreferences['editor']>): void {
  const current = getAppPreferences();
  updateAppPreferences({ editor: { ...current.editor, ...update } });
}

function renderEditorControls(): void {
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  if (!overlay?.querySelector('[data-settings-section="editor"].active')) return;
  const card = overlay.querySelector<HTMLElement>('.settings-body .settings-card');
  if (!card) return;
  const preferences = getAppPreferences();
  const editor = preferences.editor;
  card.innerHTML = [
    row('Monaco Diff Review', 'As preferências abaixo já são aplicadas ao Monaco usado para revisar alterações.', badge('Ativo', 'good')),
    row('Tamanho da fonte', 'Altera o tamanho do texto no Monaco sem reiniciar o aplicativo.', selectControl('editor-font-size', String(editor.fontSize), [['11', '11 px'], ['12', '12 px'], ['13', '13 px'], ['14', '14 px'], ['15', '15 px'], ['16', '16 px'], ['18', '18 px']])),
    row('Fonte monoespaçada', 'Escolhe a pilha de fonte usada pelo editor e pelo Diff Review.', selectControl('editor-font-family', editor.fontFamily, [['consolas', 'Consolas'], ['cascadia', 'Cascadia Code'], ['system', 'Sistema monoespaçada']])),
    row('Quebra de linha', 'Quebra linhas longas dentro da largura disponível do editor.', toggleControl('editor-word-wrap', editor.wordWrap)),
    row('Minimap', 'Mostra ou oculta o minimap lateral do Monaco.', toggleControl('editor-minimap', editor.minimap)),
    row('Indentação', 'Define o tamanho de tabulação aplicado aos modelos do Monaco.', selectControl('editor-tab-size', String(editor.tabSize), [['2', '2 espaços'], ['4', '4 espaços']])),
  ].join('');
  const footnote = overlay.querySelector<HTMLElement>('.settings-footnote');
  if (footnote) footnote.textContent = 'Preferências locais e persistentes. O futuro editor principal reutilizará o mesmo contrato, sem criar uma segunda configuração.';
}

function scheduleRender(): void {
  window.setTimeout(renderEditorControls, 0);
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('[data-settings-section="editor"]')) return;
  scheduleRender();
}, true);

document.addEventListener('change', (event) => {
  const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target) return;
  const control = target.dataset.settingsControl;
  if (!control?.startsWith('editor-')) return;

  if (control === 'editor-font-size' && target instanceof HTMLSelectElement) {
    const fontSize = Number.parseInt(target.value, 10);
    if (Number.isInteger(fontSize)) editorUpdate({ fontSize });
    return;
  }
  if (control === 'editor-font-family' && target instanceof HTMLSelectElement) {
    const fontFamily: EditorFontFamily = target.value === 'cascadia' || target.value === 'system' ? target.value : 'consolas';
    editorUpdate({ fontFamily });
    return;
  }
  if (control === 'editor-word-wrap' && target instanceof HTMLInputElement) {
    editorUpdate({ wordWrap: target.checked });
    scheduleRender();
    return;
  }
  if (control === 'editor-minimap' && target instanceof HTMLInputElement) {
    editorUpdate({ minimap: target.checked });
    scheduleRender();
    return;
  }
  if (control === 'editor-tab-size' && target instanceof HTMLSelectElement) {
    const tabSize: EditorTabSize = target.value === '2' ? 2 : 4;
    editorUpdate({ tabSize });
  }
}, true);

window.addEventListener(APP_PREFERENCES_EVENT, () => {
  if (document.querySelector('[data-settings-section="editor"].active')) scheduleRender();
});
