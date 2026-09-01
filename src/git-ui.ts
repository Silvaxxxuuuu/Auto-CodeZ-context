type GitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: Array<{ path: string; index: string; worktree: string }>;
};

type GitBranch = { name: string; current: boolean; upstream?: string };
type GitCommit = { hash: string; shortHash: string; author: string; date: string; subject: string };
type GitOperationResult = { output: string; branch: string };
type Project = { id: string; name: string; rootPath: string };
type GitActivityEvent = { type: string; status: string; gitResult?: { operation: string; branch: string; output: string } };

declare global {
  interface Window {
    autoCodez: {
      getState: () => Promise<{ projects: Project[] }>;
      onActivity: (listener: (event: GitActivityEvent) => void) => () => void;
      git: {
        status: (projectId: string) => Promise<GitStatus>;
        branches: (projectId: string) => Promise<GitBranch[]>;
        diff: (projectId: string) => Promise<string>;
        log: (input: { projectId: string; limit?: number }) => Promise<GitCommit[]>;
        createBranch: (input: { projectId: string; name: string }) => Promise<GitOperationResult>;
        checkout: (input: { projectId: string; name: string }) => Promise<GitOperationResult>;
        stage: (input: { projectId: string; paths: string[] }) => Promise<GitOperationResult>;
        stageAll: (projectId: string) => Promise<GitOperationResult>;
        commit: (input: { projectId: string; message: string }) => Promise<GitOperationResult>;
      };
    };
  }
}

const style = document.createElement('style');
style.textContent = `
.git-panel { position:fixed; right:18px; bottom:18px; width:420px; max-height:calc(100vh - 36px); display:flex; flex-direction:column; z-index:30; color:#d9dee7; background:#101318; border:1px solid rgba(255,255,255,.1); border-radius:12px; box-shadow:0 18px 50px rgba(0,0,0,.35); overflow:hidden; font:12px/1.45 Inter,system-ui,sans-serif; }
.git-panel[hidden] { display:none; }
.git-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08); }
.git-title { display:flex; align-items:center; gap:8px; font-weight:600; }
.git-icon { width:16px; height:16px; position:relative; opacity:.8; }
.git-icon::before,.git-icon::after { content:''; position:absolute; border:1.5px solid currentColor; border-radius:3px; }
.git-icon::before { width:7px; height:7px; left:0; top:1px; }
.git-icon::after { width:7px; height:7px; right:0; bottom:1px; }
.git-close,.git-refresh { border:0; background:transparent; color:inherit; cursor:pointer; opacity:.7; padding:4px 6px; border-radius:6px; }
.git-close:hover,.git-refresh:hover { background:rgba(255,255,255,.07); opacity:1; }
.git-body { overflow:auto; padding:10px; display:flex; flex-direction:column; gap:10px; }
.git-select,.git-input { width:100%; box-sizing:border-box; border:1px solid rgba(255,255,255,.1); border-radius:7px; background:#171b21; color:inherit; padding:7px 9px; outline:none; }
.git-input:focus,.git-select:focus { border-color:rgba(255,255,255,.22); }
.git-status { border:1px solid rgba(255,255,255,.08); border-radius:9px; padding:10px; }
.git-status-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.git-branch { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.git-state { font-size:11px; opacity:.75; }
.git-state.clean { color:#87c995; }
.git-state.dirty { color:#d8b36c; }
.git-sync { display:flex; gap:8px; margin-top:7px; font-size:11px; opacity:.7; }
.git-section { border-top:1px solid rgba(255,255,255,.07); padding-top:9px; }
.git-section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; }
.git-section-head strong { font-size:11px; }
.git-files,.git-branches,.git-history { display:flex; flex-direction:column; gap:5px; }
.git-file,.git-branch-row,.git-commit { padding:6px 7px; border-radius:6px; background:rgba(255,255,255,.035); min-width:0; }
.git-file { display:flex; align-items:center; gap:8px; }
.git-file-check { flex:0 0 auto; margin:0; }
.git-file-path,.git-commit-subject { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.git-file-path { flex:1 1 auto; min-width:0; }
.git-file-state { flex:0 0 auto; opacity:.55; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.git-commit-meta { display:flex; gap:7px; opacity:.55; font-size:10px; }
.git-commit-subject { margin-top:2px; }
.git-muted { opacity:.55; padding:4px 0; }
.git-error { color:#e59a9a; padding:4px 0; }
.git-success { color:#87c995; padding:4px 0; }
.git-diff { margin:0; max-height:260px; overflow:auto; white-space:pre; font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:#0b0d10; border-radius:7px; padding:9px; color:#cbd1da; }
.git-actions { display:flex; flex-wrap:wrap; gap:6px; }
.git-button { border:1px solid rgba(255,255,255,.1); background:#171b21; color:inherit; border-radius:7px; padding:6px 9px; cursor:pointer; font:inherit; }
.git-button:hover:not(:disabled) { background:#20252d; }
.git-button:disabled { opacity:.45; cursor:default; }
.git-form { display:flex; gap:6px; }
.git-form .git-input { flex:1 1 auto; min-width:0; }
.git-form .git-button { flex:0 0 auto; }
`;
document.head.appendChild(style);

const root = document.createElement('section');
root.className = 'git-panel';
root.hidden = true;
root.innerHTML = `
  <header class="git-head">
    <div class="git-title"><span class="git-icon" aria-hidden="true"></span><span>Git</span></div>
    <div><button class="git-refresh" id="git-refresh" title="Atualizar" aria-label="Atualizar">↻</button><button class="git-close" id="git-close" title="Fechar" aria-label="Fechar">×</button></div>
  </header>
  <div class="git-body">
    <select class="git-select" id="git-project" aria-label="Projeto Git"></select>
    <div id="git-content"></div>
  </div>
`;
document.body.appendChild(root);

const projectSelect = root.querySelector<HTMLSelectElement>('#git-project')!;
const content = root.querySelector<HTMLDivElement>('#git-content')!;

let projects: Project[] = [];
let selectedProjectId = '';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', '?': '?' };
  return labels[status] || status || ' ';
}

async function loadProjects(): Promise<void> {
  const state = await window.autoCodez.getState();
  projects = state.projects;
  projectSelect.innerHTML = projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  if (!projects.length) {
    selectedProjectId = '';
    content.innerHTML = '<div class="git-muted">Nenhum projeto disponível.</div>';
    return;
  }
  if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = projects[0].id;
  projectSelect.value = selectedProjectId;
  await refreshGit();
}

async function runOperation(operation: () => Promise<GitOperationResult>, successMessage: string): Promise<void> {
  content.insertAdjacentHTML('afterbegin', '<div class="git-muted" id="git-operation-state">Executando operação Git...</div>');
  try {
    const result = await operation();
    await refreshGit();
    content.insertAdjacentHTML('afterbegin', `<div class="git-success">${escapeHtml(successMessage)}${result.output ? ` ${escapeHtml(result.output)}` : ''}</div>`);
  } catch (error) {
    content.insertAdjacentHTML('afterbegin', `<div class="git-error">${escapeHtml(error instanceof Error ? error.message : 'Operação Git falhou.')}</div>`);
  }
}

function renderActions(status: GitStatus, branches: GitBranch[]): string {
  const files = status.files.slice(0, 40);
  return `
    <section class="git-section">
      <div class="git-section-head"><strong>Git</strong></div>
      <div class="git-actions">
        <button class="git-button" id="git-stage-all" ${files.length ? '' : 'disabled'}>Adicionar tudo</button>
        <button class="git-button" id="git-commit-button" ${status.files.some((file) => file.index.trim()) ? '' : 'disabled'}>Commit</button>
      </div>
      <div class="git-form" style="margin-top:7px"><input class="git-input" id="git-branch-name" placeholder="Nome da nova branch" maxlength="200"><button class="git-button" id="git-create-branch">Criar branch</button></div>
      <div class="git-form" style="margin-top:7px"><select class="git-select" id="git-checkout-name">${branches.map((branch) => `<option value="${escapeHtml(branch.name)}" ${branch.current ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('')}</select><button class="git-button" id="git-checkout">Trocar</button></div>
    </section>
  `;
}

async function refreshGit(): Promise<void> {
  selectedProjectId = projectSelect.value;
  if (!selectedProjectId) return;
  content.innerHTML = '<div class="git-muted">Atualizando Git...</div>';
  try {
    const [status, branches, commits, diff] = await Promise.all([
      window.autoCodez.git.status(selectedProjectId),
      window.autoCodez.git.branches(selectedProjectId),
      window.autoCodez.git.log({ projectId: selectedProjectId, limit: 8 }),
      window.autoCodez.git.diff(selectedProjectId),
    ]);
    const files = status.files.slice(0, 40);
    content.innerHTML = `
      <section class="git-status">
        <div class="git-status-row"><span class="git-branch">${escapeHtml(status.branch)}</span><span class="git-state ${status.clean ? 'clean' : 'dirty'}">${status.clean ? 'Limpo' : `${status.files.length} alteração${status.files.length === 1 ? '' : 'ões'}`}</span></div>
        <div class="git-sync"><span>↑ ${status.ahead}</span><span>↓ ${status.behind}</span></div>
      </section>
      ${renderActions(status, branches)}
      <section class="git-section"><div class="git-section-head"><strong>Alterações</strong><span class="git-muted">marque os arquivos para staging</span></div><div class="git-files">${files.map((file) => `<label class="git-file"><input class="git-file-check" type="checkbox" data-git-file="${escapeHtml(file.path)}" ${file.index.trim() ? 'checked' : ''}><span class="git-file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span><span class="git-file-state">${escapeHtml(statusLabel(file.index || file.worktree))}</span></label>`).join('') || '<div class="git-muted">Nenhuma alteração.</div>'}</div></section>
      <section class="git-section"><div class="git-section-head"><strong>Branches</strong></div><div class="git-branches">${branches.slice(0, 20).map((branch) => `<div class="git-branch-row">${branch.current ? '● ' : ''}${escapeHtml(branch.name)}${branch.upstream ? ` <span class="git-muted">· ${escapeHtml(branch.upstream)}</span>` : ''}</div>`).join('') || '<div class="git-muted">Nenhuma branch encontrada.</div>'}</div></section>
      <section class="git-section"><div class="git-section-head"><strong>Histórico</strong></div><div class="git-history">${commits.map((commit) => `<div class="git-commit"><div class="git-commit-meta"><span>${escapeHtml(commit.shortHash)}</span><span>${escapeHtml(commit.author)}</span></div><div class="git-commit-subject" title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</div></div>`).join('') || '<div class="git-muted">Nenhum commit encontrado.</div>'}</div></section>
      <section class="git-section"><div class="git-section-head"><strong>Diff atual</strong></div>${diff ? `<pre class="git-diff">${escapeHtml(diff)}</pre>` : '<div class="git-muted">Nenhum diff no working tree.</div>'}</section>
    `;

    root.querySelector('#git-stage-all')?.addEventListener('click', () => {
      if (!confirm('Adicionar todas as alterações ao staging?')) return;
      void runOperation(() => window.autoCodez.git.stageAll(selectedProjectId), 'Alterações adicionadas ao staging.');
    });
    root.querySelector('#git-commit-button')?.addEventListener('click', () => {
      const message = prompt('Mensagem do commit:');
      if (!message?.trim()) return;
      if (!confirm(`Criar commit com a mensagem:\n\n${message.trim()}\n\nContinuar?`)) return;
      void runOperation(() => window.autoCodez.git.commit({ projectId: selectedProjectId, message: message.trim() }), 'Commit criado.');
    });
    root.querySelector('#git-create-branch')?.addEventListener('click', () => {
      const input = root.querySelector<HTMLInputElement>('#git-branch-name');
      const name = input?.value.trim() || '';
      if (!name) return;
      if (!confirm(`Criar e trocar para a branch "${name}"?`)) return;
      void runOperation(() => window.autoCodez.git.createBranch({ projectId: selectedProjectId, name }), 'Branch criada.');
    });
    root.querySelector('#git-checkout')?.addEventListener('click', () => {
      const select = root.querySelector<HTMLSelectElement>('#git-checkout-name');
      const name = select?.value || '';
      if (!name || name === status.branch) return;
      if (!confirm(`Trocar da branch "${status.branch}" para "${name}"? O Git rejeitará a troca se houver conflito com alterações locais.`)) return;
      void runOperation(() => window.autoCodez.git.checkout({ projectId: selectedProjectId, name }), 'Branch alterada.');
    });
    root.querySelectorAll<HTMLInputElement>('[data-git-file]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const selected = Array.from(root.querySelectorAll<HTMLInputElement>('[data-git-file]:checked')).map((item) => item.dataset.gitFile || '').filter(Boolean);
        const button = root.querySelector<HTMLButtonElement>('#git-stage-selected');
        if (button) button.disabled = selected.length === 0;
      });
    });
    const stageSelected = document.createElement('button');
    stageSelected.className = 'git-button';
    stageSelected.id = 'git-stage-selected';
    stageSelected.textContent = 'Adicionar selecionados';
    stageSelected.disabled = !files.some((file) => file.index.trim());
    stageSelected.addEventListener('click', () => {
      const selected = Array.from(root.querySelectorAll<HTMLInputElement>('[data-git-file]:checked')).map((item) => item.dataset.gitFile || '').filter(Boolean);
      if (!selected.length || !confirm(`Adicionar ${selected.length} arquivo(s) ao staging?`)) return;
      void runOperation(() => window.autoCodez.git.stage({ projectId: selectedProjectId, paths: selected }), 'Arquivos adicionados ao staging.');
    });
    root.querySelector('#git-stage-all')?.insertAdjacentElement('afterend', stageSelected);
  } catch (error) {
    content.innerHTML = `<div class="git-error">${escapeHtml(error instanceof Error ? error.message : 'Não foi possível consultar o Git.')}</div>`;
  }
}

function toggle(): void {
  root.hidden = !root.hidden;
  if (!root.hidden) void loadProjects();
}

const trigger = document.createElement('button');
trigger.className = 'rail-button';
trigger.title = 'Git';
trigger.setAttribute('aria-label', 'Git');
trigger.innerHTML = '<span aria-hidden="true">⑂</span>';
trigger.addEventListener('click', toggle);

function mountTrigger(): void {
  const rail = document.querySelector<HTMLElement>('.rail');
  const spacer = rail?.querySelector<HTMLElement>('.rail-spacer');
  if (!rail || !spacer || trigger.isConnected) return;
  rail.insertBefore(trigger, spacer);
}

mountTrigger();
if (!trigger.isConnected) window.setTimeout(mountTrigger, 0);

projectSelect.addEventListener('change', () => void refreshGit());
root.querySelector('#git-refresh')!.addEventListener('click', () => void refreshGit());
root.querySelector('#git-close')!.addEventListener('click', () => { root.hidden = true; });

window.addEventListener('focus', () => {
  if (!root.hidden) void refreshGit();
});

const unsubscribeGitActivity = window.autoCodez.onActivity((event) => {
  if (!event.gitResult) return;
  if (!root.hidden && selectedProjectId) void refreshGit();
});
window.addEventListener('beforeunload', unsubscribeGitActivity, { once: true });