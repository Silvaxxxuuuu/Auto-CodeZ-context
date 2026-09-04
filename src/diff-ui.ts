import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/editor/editor.main.css';

type DiffChange = {
  path: string;
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
  renamedFrom?: string;
};

type DiffPlan = {
  id: string;
  createdAt: number;
  changes: DiffChange[];
  summary: {
    files: number;
    created: number;
    modified: number;
    deleted: number;
    renamed: number;
    addedLines: number;
    removedLines: number;
  };
};

type Approval = {
  id: string;
  chatId?: string;
  runId?: string;
  createdAt: number;
  toolCall: { id: string; name: string; input: Record<string, unknown> };
  diffPlan?: DiffPlan;
};

type DiffBridge = {
  listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Approval[]>;
  onStreamEvent: (listener: (event: { type?: string; chatId?: string; runId?: string }) => void) => () => void;
};

type MonacoModule = typeof import('monaco-editor/esm/vs/editor/editor.api');
type DiffEditor = ReturnType<MonacoModule['editor']['createDiffEditor']>;
type TextModel = ReturnType<MonacoModule['editor']['createModel']>;

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: () => Worker;
    };
  }
}

const bridge = (window as unknown as { autoCodez?: DiffBridge }).autoCodez;
if (!bridge?.listApprovals || !bridge.onStreamEvent) throw new Error('Infraestrutura de diff indisponível.');

window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const style = document.createElement('style');
style.id = 'auto-codez-monaco-diff-review';
style.textContent = `
.ac-diff-review-backdrop{position:fixed;inset:0;z-index:12000;display:grid;place-items:center;padding:28px;background:rgba(4,7,10,.72);backdrop-filter:blur(5px)}
.ac-diff-review-backdrop[hidden]{display:none}
.ac-diff-review{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(1180px,calc(100vw - 56px));height:min(760px,calc(100vh - 56px));overflow:hidden;border:1px solid #303843;border-radius:14px;background:#0e1217;box-shadow:0 28px 90px #000a;color:#dfe5ec}
.ac-diff-review-head{display:flex;align-items:center;gap:14px;padding:13px 15px;border-bottom:1px solid #222a33;background:#11161c}
.ac-diff-review-title{min-width:0;display:flex;flex:1;flex-direction:column;gap:3px}
.ac-diff-review-title strong{font-size:13px;font-weight:650;color:#eef2f6}
.ac-diff-review-title span{font-size:10px;color:#7f8a98}
.ac-diff-review-stats{display:flex;align-items:center;gap:9px;font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8e99a7;white-space:nowrap}
.ac-diff-review-stats .add{color:#8bc39a}.ac-diff-review-stats .remove{color:#d89090}
.ac-diff-review-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:#8e99a7;cursor:pointer;font-size:20px;line-height:1}
.ac-diff-review-close:hover{background:#1b222b;color:#eef2f6}
.ac-diff-review-body{display:grid;grid-template-columns:245px minmax(0,1fr);min-height:0}
.ac-diff-review-files{min-height:0;overflow:auto;border-right:1px solid #222a33;background:#0c1015;padding:7px}
.ac-diff-file{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;width:100%;padding:9px 10px;border:0;border-radius:7px;background:transparent;color:#aeb8c4;text-align:left;cursor:pointer}
.ac-diff-file:hover{background:#141a21}.ac-diff-file.active{background:#19212a;color:#edf2f7}
.ac-diff-file-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}
.ac-diff-file-meta{grid-column:1 / -1;display:flex;gap:7px;font-size:9px;color:#74808d}
.ac-diff-file-count{font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#7d8895}
.ac-diff-editor-shell{position:relative;min-width:0;min-height:0;background:#0e1217}
.ac-diff-editor{position:absolute;inset:0}
.ac-diff-loading,.ac-diff-empty{position:absolute;inset:0;display:grid;place-items:center;padding:24px;color:#7f8a97;font-size:11px;text-align:center}
.ac-diff-review-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;border-top:1px solid #222a33;background:#11161c}
.ac-diff-review-note{font-size:9px;color:#717d8a}
.ac-diff-review-buttons{display:flex;gap:8px}
.ac-diff-review-buttons button{height:31px;padding:0 14px;border-radius:7px;font:600 10px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.ac-diff-review-buttons button:disabled{opacity:.52;cursor:default}
.ac-diff-deny{border:1px solid #343d48;background:#151b22;color:#b3bdc9}.ac-diff-deny:not(:disabled):hover{background:#1d242d;color:#f0f3f7}
.ac-diff-approve{border:1px solid #d3dae3;background:#e4e9ef;color:#0b0f14}.ac-diff-approve:not(:disabled):hover{background:#f3f6f9}
@media(max-width:760px){.ac-diff-review-backdrop{padding:12px}.ac-diff-review{width:calc(100vw - 24px);height:calc(100vh - 24px)}.ac-diff-review-body{grid-template-columns:1fr;grid-template-rows:150px minmax(0,1fr)}.ac-diff-review-files{border-right:0;border-bottom:1px solid #222a33}.ac-diff-review-stats{display:none}.ac-diff-review-note{display:none}}
`;
if (!document.getElementById(style.id)) document.head.appendChild(style);

const root = document.createElement('div');
root.className = 'ac-diff-review-backdrop';
root.hidden = true;
root.innerHTML = `
  <section class="ac-diff-review" role="dialog" aria-modal="true" aria-label="Revisar alterações">
    <header class="ac-diff-review-head">
      <div class="ac-diff-review-title"><strong>Revisar alterações</strong><span></span></div>
      <div class="ac-diff-review-stats"></div>
      <button class="ac-diff-review-close" type="button" aria-label="Fechar">×</button>
    </header>
    <div class="ac-diff-review-body">
      <nav class="ac-diff-review-files" aria-label="Arquivos alterados"></nav>
      <div class="ac-diff-editor-shell">
        <div class="ac-diff-loading">Carregando Monaco Diff Editor…</div>
        <div class="ac-diff-editor"></div>
      </div>
    </div>
    <footer class="ac-diff-review-actions">
      <div class="ac-diff-review-note">A revisão é somente leitura. A alteração só é aplicada depois da aprovação.</div>
      <div class="ac-diff-review-buttons">
        <button type="button" class="ac-diff-deny">Recusar</button>
        <button type="button" class="ac-diff-approve">Aprovar alteração</button>
      </div>
    </footer>
  </section>`;
document.body.appendChild(root);

const fileList = root.querySelector<HTMLElement>('.ac-diff-review-files');
const editorHost = root.querySelector<HTMLElement>('.ac-diff-editor');
const loading = root.querySelector<HTMLElement>('.ac-diff-loading');
const titleDetail = root.querySelector<HTMLElement>('.ac-diff-review-title span');
const stats = root.querySelector<HTMLElement>('.ac-diff-review-stats');
const closeButton = root.querySelector<HTMLButtonElement>('.ac-diff-review-close');
const approveButton = root.querySelector<HTMLButtonElement>('.ac-diff-approve');
const denyButton = root.querySelector<HTMLButtonElement>('.ac-diff-deny');
if (!fileList || !editorHost || !loading || !titleDetail || !stats || !closeButton || !approveButton || !denyButton) throw new Error('Estrutura do Monaco Diff Review incompleta.');

let currentApproval: Approval | null = null;
let currentChangeIndex = 0;
let monacoPromise: Promise<MonacoModule> | null = null;
let diffEditor: DiffEditor | null = null;
let originalModel: TextModel | null = null;
let modifiedModel: TextModel | null = null;
let requestToken = 0;

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function typeLabel(type: DiffChange['type']): string {
  return ({ created: 'Criado', modified: 'Modificado', deleted: 'Excluído', renamed: 'Renomeado' })[type];
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  const languages: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
    py: 'python', java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    go: 'go', rs: 'rust', php: 'php', rb: 'ruby', sh: 'shell', bash: 'shell', ps1: 'powershell',
    sql: 'sql', xml: 'xml', yaml: 'yaml', yml: 'yaml', txt: 'plaintext',
  };
  return languages[extension] || 'plaintext';
}

function disposeModels(): void {
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
}

async function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) monacoPromise = import('monaco-editor/esm/vs/editor/editor.api');
  return monacoPromise;
}

async function ensureEditor(): Promise<{ monaco: MonacoModule; editor: DiffEditor }> {
  const monaco = await loadMonaco();
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(editorHost, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      enableSplitViewResizing: true,
      renderOverviewRuler: true,
      minimap: { enabled: false },
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      fontSize: 12,
      lineHeight: 19,
      fontFamily: 'Consolas, "Cascadia Code", monospace',
      padding: { top: 10, bottom: 10 },
      ignoreTrimWhitespace: false,
      renderIndicators: true,
      renderMarginRevertIcon: false,
      hideUnchangedRegions: { enabled: false },
      originalAriaLabel: 'Conteúdo atual',
      modifiedAriaLabel: 'Conteúdo proposto',
      theme: 'vs-dark',
    });
  }
  return { monaco, editor: diffEditor };
}

function renderFileList(): void {
  const changes = currentApproval?.diffPlan?.changes || [];
  fileList.replaceChildren(...changes.map((change, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ac-diff-file${index === currentChangeIndex ? ' active' : ''}`;
    button.dataset.changeIndex = String(index);
    button.title = change.path;
    const path = document.createElement('span');
    path.className = 'ac-diff-file-path';
    path.textContent = change.path;
    const count = document.createElement('span');
    count.className = 'ac-diff-file-count';
    count.textContent = `+${change.addedLines} -${change.removedLines}`;
    const meta = document.createElement('span');
    meta.className = 'ac-diff-file-meta';
    meta.textContent = change.renamedFrom ? `${typeLabel(change.type)} · ${change.renamedFrom} → ${change.path}` : typeLabel(change.type);
    button.append(path, count, meta);
    return button;
  }));
}

async function renderSelectedChange(): Promise<void> {
  const approval = currentApproval;
  const change = approval?.diffPlan?.changes[currentChangeIndex];
  if (!approval || !change) {
    loading.textContent = 'Nenhuma alteração disponível para revisão.';
    loading.hidden = false;
    diffEditor?.setModel(null);
    disposeModels();
    return;
  }
  loading.textContent = 'Carregando Monaco Diff Editor…';
  loading.hidden = false;
  try {
    const { monaco, editor } = await ensureEditor();
    if (approval !== currentApproval || change !== currentApproval.diffPlan?.changes[currentChangeIndex]) return;
    disposeModels();
    const language = languageForPath(change.path);
    originalModel = monaco.editor.createModel(change.before, language);
    modifiedModel = monaco.editor.createModel(change.after, language);
    editor.setModel({ original: originalModel, modified: modifiedModel });
    editor.updateOptions({ renderSideBySide: window.innerWidth >= 760 });
    editor.getOriginalEditor().setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    editor.getModifiedEditor().setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    loading.hidden = true;
  } catch (error) {
    loading.textContent = error instanceof Error ? `Não foi possível carregar o Monaco Diff Editor: ${error.message}` : 'Não foi possível carregar o Monaco Diff Editor.';
    loading.hidden = false;
  }
}

function setProcessing(processing: boolean): void {
  approveButton.disabled = processing;
  denyButton.disabled = processing;
  closeButton.disabled = processing;
  approveButton.textContent = processing ? 'Processando…' : 'Aprovar alteração';
  denyButton.textContent = processing ? 'Processando…' : 'Recusar';
}

function closeReview(): void {
  currentApproval = null;
  currentChangeIndex = 0;
  root.hidden = true;
  diffEditor?.setModel(null);
  disposeModels();
  setProcessing(false);
}

async function openReview(approvalId: string): Promise<void> {
  const token = ++requestToken;
  const chatId = selectedChatId();
  if (!chatId) return;
  const approvals = await bridge.listApprovals({ chatId });
  if (token !== requestToken || selectedChatId() !== chatId) return;
  const approval = approvals.find((item) => item.id === approvalId && item.chatId === chatId);
  if (!approval?.diffPlan?.changes.length) return;
  currentApproval = approval;
  currentChangeIndex = 0;
  titleDetail.textContent = approval.diffPlan.changes.length === 1 ? approval.diffPlan.changes[0].path : `${approval.diffPlan.changes.length} arquivos nesta alteração`;
  stats.innerHTML = `<span>${approval.diffPlan.summary.files} arquivo${approval.diffPlan.summary.files === 1 ? '' : 's'}</span><span class="add">+${approval.diffPlan.summary.addedLines}</span><span class="remove">-${approval.diffPlan.summary.removedLines}</span>`;
  approveButton.dataset.approve = approval.id;
  denyButton.dataset.deny = approval.id;
  renderFileList();
  root.hidden = false;
  setProcessing(false);
  await renderSelectedChange();
}

async function refreshOpenReview(): Promise<void> {
  const approval = currentApproval;
  if (!approval) return;
  const chatId = selectedChatId();
  if (!chatId || approval.chatId !== chatId) {
    closeReview();
    return;
  }
  const approvals = await bridge.listApprovals({ chatId }).catch(() => []);
  const fresh = approvals.find((item) => item.id === approval.id);
  if (!fresh?.diffPlan?.changes.length) {
    closeReview();
    return;
  }
  currentApproval = fresh;
  setProcessing(false);
}

fileList.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-change-index]');
  if (!target) return;
  const index = Number.parseInt(target.dataset.changeIndex || '', 10);
  if (!Number.isInteger(index) || !currentApproval?.diffPlan?.changes[index] || index === currentChangeIndex) return;
  currentChangeIndex = index;
  renderFileList();
  void renderSelectedChange();
});

closeButton.addEventListener('click', closeReview);
root.addEventListener('click', (event) => {
  if (event.target === root) closeReview();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !root.hidden && !approveButton.disabled) closeReview();
});

document.addEventListener('auto-codez-open-diff-review', (event) => {
  const approvalId = (event as CustomEvent<{ approvalId?: string }>).detail?.approvalId;
  if (approvalId) void openReview(approvalId);
});

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-approve], [data-deny]')) setProcessing(true);
}, true);

bridge.onStreamEvent((event) => {
  if (!currentApproval) return;
  if (event.chatId && event.chatId !== currentApproval.chatId) return;
  if (event.type === 'approval_required' || event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') void refreshOpenReview();
});

window.addEventListener('resize', () => {
  if (diffEditor) diffEditor.updateOptions({ renderSideBySide: window.innerWidth >= 760 });
});

window.addEventListener('beforeunload', () => {
  diffEditor?.dispose();
  diffEditor = null;
  disposeModels();
}, { once: true });
