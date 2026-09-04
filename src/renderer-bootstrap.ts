type ModuleLoader = readonly [name: string, load: () => Promise<unknown>];

const enhancementModules: readonly ModuleLoader[] = [
  ['ui-polish', () => import('./ui-polish')],
  ['settings-ui', () => import('./settings-ui')],
  ['stop-control', () => import('./stop-control')],
  ['composer-resilience', () => import('./composer-resilience')],
  ['thinking-ui', () => import('./thinking-ui')],
  ['chat-execution-ui', () => import('./chat-execution-ui')],
  ['approval-ui', () => import('./approval-ui')],
  ['terminal-ui', () => import('./terminal-ui')],
  ['activity-ui', () => import('./activity-ui')],
  ['chat-rename-ui', () => import('./chat-rename-ui')],
  ['api-settings-routing-ui', () => import('./api-settings-routing-ui')],
  ['initial-chat-ui', () => import('./initial-chat-ui')],
  ['profile-ui', () => import('./profile-ui')],
  ['chat-api-key-settings-ui', () => import('./chat-api-key-settings-ui')],
  ['api-key-ui', () => import('./api-key-ui')],
  ['error-recovery-ui', () => import('./error-recovery-ui')],
  ['api-key-flow-polish', () => import('./api-key-flow-polish')],
  ['execution-visibility', () => import('./execution-visibility')],
  ['diff-ui', () => import('./diff-ui')],
  ['git-ui', () => import('./git-ui')],
  ['git-actions-ui', () => import('./git-actions-ui')],
];

function showBootstrapError(failures: string[]): void {
  const existing = document.getElementById('auto-codez-bootstrap-error');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'auto-codez-bootstrap-error';
  panel.setAttribute('role', 'alert');
  panel.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'max-width:520px',
    'padding:12px 14px',
    'border:1px solid #633a40',
    'border-radius:10px',
    'background:#1b1114',
    'color:#efc7cb',
    'font:11px/1.5 Inter,Segoe UI,sans-serif',
    'box-shadow:0 18px 60px #0008',
  ].join(';');
  panel.textContent = `Falha ao inicializar a interface: ${failures.join(', ')}`;
  document.body.appendChild(panel);
}

function verifyCriticalUi(): string[] {
  const missing: string[] = [];
  if (!document.querySelector('.app-shell')) missing.push('app-shell');
  if (!document.getElementById('auto-codez-ui-polish')) missing.push('ui-polish');
  if (!document.getElementById('ac-app-settings')) missing.push('app-settings');
  if (!document.querySelector('.terminal-rail-button')) missing.push('terminal-ui');
  return missing;
}

async function bootstrap(): Promise<void> {
  const failures: string[] = [];

  try {
    await import('./stream-performance');
  } catch (error) {
    console.error('Falha ao inicializar stream-performance.', error);
    failures.push('stream-performance');
  }

  try {
    await import('./renderer');
  } catch (error) {
    console.error('Falha ao inicializar renderer.', error);
    showBootstrapError(['renderer']);
    return;
  }

  for (const [name, load] of enhancementModules) {
    try {
      await load();
    } catch (error) {
      console.error(`Falha ao inicializar ${name}.`, error);
      failures.push(name);
    }
  }

  failures.push(...verifyCriticalUi().filter((name) => !failures.includes(name)));
  document.documentElement.dataset.autoCodezUiRuntime = failures.length ? 'degraded' : 'ready';

  if (failures.length) showBootstrapError(failures);
}

void bootstrap();
