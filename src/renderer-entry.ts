import './renderer';

type Enhancement = {
  name: string;
  load: () => Promise<unknown>;
};

const criticalEnhancements: Enhancement[] = [
  { name: 'terminal-ui', load: () => import('./terminal-ui') },
  { name: 'terminal-visual-ui', load: () => import('./terminal-visual-ui') },
  { name: 'api-key-ui', load: () => import('./api-key-ui') },
  { name: 'ui-polish', load: () => import('./ui-polish') },
  { name: 'settings-ui', load: () => import('./settings-ui') },
  { name: 'initial-chat-ui', load: () => import('./initial-chat-ui') },
  { name: 'profile-ui', load: () => import('./profile-ui') },
  { name: 'chat-api-key-settings-ui', load: () => import('./chat-api-key-settings-ui') },
  { name: 'api-key-flow-polish', load: () => import('./api-key-flow-polish') },
  { name: 'api-key-manager-ux', load: () => import('./api-key-manager-ux') },
  { name: 'api-settings-routing-ui', load: () => import('./api-settings-routing-ui') },
  { name: 'approval-ui', load: () => import('./approval-ui') },
  { name: 'diff-review-launcher-ui', load: () => import('./diff-review-launcher-ui') },
  { name: 'composer-resilience', load: () => import('./composer-resilience') },
  { name: 'live-activity-ui', load: () => import('./live-activity-ui') },
  { name: 'provider-error-ui', load: () => import('./provider-error-ui') },
];

const secondaryEnhancements: Enhancement[] = [
  { name: 'thinking-ui', load: () => import('./thinking-ui') },
  { name: 'chat-execution-ui', load: () => import('./chat-execution-ui') },
  { name: 'activity-ui', load: () => import('./activity-ui') },
  { name: 'diff-ui', load: () => import('./diff-ui') },
  { name: 'chat-rename-ui', load: () => import('./chat-rename-ui') },
  { name: 'error-recovery-ui', load: () => import('./error-recovery-ui') },
  { name: 'execution-visibility', load: () => import('./execution-visibility') },
  { name: 'stop-control', load: () => import('./stop-control') },
];

const failures = new Map<string, unknown>();

function renderFailures(): void {
  const existing = document.querySelector<HTMLElement>('#auto-codez-module-failures');
  if (!failures.size) {
    existing?.remove();
    return;
  }

  const marker = existing ?? document.createElement('div');
  marker.id = 'auto-codez-module-failures';
  marker.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:520px;padding:10px 12px;background:#351414;color:#ffd4d4;border:1px solid #8d3f3f;border-radius:8px;font:12px/1.45 Consolas,monospace;white-space:pre-wrap;box-shadow:0 8px 28px #0008';
  marker.textContent = `Falha em ${failures.size} módulo(s):\n${Array.from(failures.keys()).join('\n')}`;
  if (!existing) document.body.appendChild(marker);
}

async function loadEnhancement(enhancement: Enhancement): Promise<void> {
  try {
    await enhancement.load();
  } catch (error) {
    failures.set(enhancement.name, error);
    console.error(`Falha ao inicializar ${enhancement.name}.`, error);
    renderFailures();
  }
}

async function initializeEnhancements(): Promise<void> {
  for (const enhancement of criticalEnhancements) await loadEnhancement(enhancement);
  for (const enhancement of secondaryEnhancements) void loadEnhancement(enhancement);
}

void initializeEnhancements();
