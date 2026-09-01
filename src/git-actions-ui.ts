type GitMutationApi = {
  git: {
    createBranch: (input: { projectId: string; name: string }) => Promise<{ output: string; branch: string }>;
    checkout: (input: { projectId: string; name: string }) => Promise<{ output: string; branch: string }>;
    commit: (input: { projectId: string; message: string }) => Promise<{ output: string; branch: string }>;
  };
};

const api = (window as unknown as { autoCodez: GitMutationApi }).autoCodez;

const style = document.createElement('style');
style.textContent = `
.git-actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.git-action { border:1px solid rgba(255,255,255,.1); border-radius:7px; background:#171b21; color:#d9dee7; padding:7px 9px; cursor:pointer; font:11px Inter,system-ui,sans-serif; }
.git-action:hover { background:#20252d; }
.git-action:disabled { opacity:.5; cursor:default; }
.git-action-wide { grid-column:1 / -1; }
.git-action-status { font-size:11px; opacity:.7; min-height:16px; }
`;
document.head.appendChild(style);

function getProjectId(): string {
  return document.querySelector<HTMLSelectElement>('#git-project')?.value || '';
}

function setStatus(value: string, error = false): void {
  const element = document.querySelector<HTMLDivElement>('#git-action-status');
  if (!element) return;
  element.textContent = value;
  element.style.color = error ? '#e59a9a' : '';
}

async function refreshGitPanel(): Promise<void> {
  document.querySelector<HTMLButtonElement>('#git-refresh')?.click();
}

function install(): void {
  const body = document.querySelector<HTMLElement>('.git-body');
  if (!body || document.querySelector('#git-actions')) return;
  const actions = document.createElement('section');
  actions.id = 'git-actions';
  actions.innerHTML = `
    <div class="git-section">
      <div class="git-section-head"><strong>Operações</strong></div>
      <div class="git-actions">
        <button class="git-action" id="git-new-branch">Nova branch</button>
        <button class="git-action" id="git-checkout">Trocar branch</button>
        <button class="git-action git-action-wide" id="git-commit">Criar commit</button>
      </div>
      <div class="git-action-status" id="git-action-status" aria-live="polite"></div>
    </div>
  `;
  body.appendChild(actions);

  document.querySelector<HTMLButtonElement>('#git-new-branch')?.addEventListener('click', async () => {
    const projectId = getProjectId();
    if (!projectId) return;
    const name = window.prompt('Nome da nova branch:');
    if (!name?.trim()) return;
    if (!window.confirm(`Criar a branch "${name.trim()}" a partir da branch atual?`)) return;
    setStatus('Criando branch...');
    try {
      const result = await api.git.createBranch({ projectId, name: name.trim() });
      setStatus(`Branch ${result.branch} criada.`);
      await refreshGitPanel();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Não foi possível criar a branch.', true);
    }
  });

  document.querySelector<HTMLButtonElement>('#git-checkout')?.addEventListener('click', async () => {
    const projectId = getProjectId();
    if (!projectId) return;
    const name = window.prompt('Nome da branch existente para trocar:');
    if (!name?.trim()) return;
    if (!window.confirm(`Trocar para a branch "${name.trim()}"? Alterações locais incompatíveis podem impedir a operação.`)) return;
    setStatus('Trocando branch...');
    try {
      const result = await api.git.checkout({ projectId, name: name.trim() });
      setStatus(`Branch atual: ${result.branch}.`);
      await refreshGitPanel();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Não foi possível trocar de branch.', true);
    }
  });

  document.querySelector<HTMLButtonElement>('#git-commit')?.addEventListener('click', async () => {
    const projectId = getProjectId();
    if (!projectId) return;
    const message = window.prompt('Mensagem do commit:');
    if (!message?.trim()) return;
    if (!window.confirm(`Criar um commit com a mensagem:\n\n${message.trim()}`)) return;
    setStatus('Criando commit...');
    try {
      const result = await api.git.commit({ projectId, message: message.trim() });
      setStatus(`Commit criado em ${result.branch}.`);
      await refreshGitPanel();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Não foi possível criar o commit.', true);
    }
  });
}

install();
window.setTimeout(install, 0);
window.setTimeout(install, 100);
