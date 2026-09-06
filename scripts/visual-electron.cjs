const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const packagedExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const electronExecutable = packagedExecutable || require('electron');
const VISUAL_WATCHDOG_MS = 6 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 10 * 1000;

const results = [];
const pageErrors = [];
const consoleErrors = [];
let electronApp;
let page;
let watchdog;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeDiagnostic(name, value) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, name), `${value}\n`, 'utf8');
}

async function screenshot(name) {
  await page.waitForTimeout(220);
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    animations: 'disabled',
  });
}

async function assertHealthy() {
  const failureMarker = page.locator('#auto-codez-module-failures');
  if (await failureMarker.count()) {
    const text = (await failureMarker.first().innerText()).trim();
    throw new Error(text || 'Um módulo da interface falhou ao inicializar.');
  }
}

async function step(name, action) {
  try {
    await action();
    await assertHealthy();
    await screenshot(name);
    results.push({ name, status: 'passed' });
  } catch (error) {
    const message = errorText(error);
    results.push({ name, status: 'failed', error: message });
    try {
      if (page && !page.isClosed()) await screenshot(`falha-${name}`);
    } catch {}
  }
}

async function waitForText(selector, text) {
  const locator = page.locator(selector).filter({ hasText: text }).first();
  await locator.waitFor({ state: 'visible', timeout: 15000 });
}

async function clickIfVisible(selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return;
  if (!(await locator.isVisible().catch(() => false))) return;
  await locator.click().catch(() => {});
}

async function closeTransientUi() {
  await clickIfVisible('.api-key-manager-close');
  await clickIfVisible('[data-profile-close]');
  await clickIfVisible('[data-settings-close]');
  await clickIfVisible('#terminal-close');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(120);
}

async function stopVisualTerminalSessions() {
  if (!page || page.isClosed()) return;
  await page.evaluate(async () => {
    const api = window.autoCodez?.terminal;
    if (!api) return;
    const sessions = await api.listSessions();
    for (const session of sessions) {
      if (session.status !== 'running') continue;
      try {
        await api.kill(session.id);
      } catch {}
    }
  }).catch(() => {});
}

function forceKillElectronTree() {
  const child = electronApp?.process();
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {}
}

async function closeElectronSafely() {
  if (!electronApp) return;
  await stopVisualTerminalSessions();
  let closed = false;
  await Promise.race([
    electronApp.close().then(() => { closed = true; }).catch(() => {}),
    delay(CLOSE_TIMEOUT_MS),
  ]);
  if (!closed) forceKillElectronTree();
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  await writeDiagnostic('run-started.txt', `Visual run started at ${new Date().toISOString()}`);

  watchdog = setTimeout(async () => {
    await writeDiagnostic('fatal-error.txt', `Visual watchdog exceeded ${VISUAL_WATCHDOG_MS}ms.`).catch(() => {});
    forceKillElectronTree();
    process.exit(1);
  }, VISUAL_WATCHDOG_MS);
  watchdog.unref?.();

  electronApp = await electron.launch({
    executablePath: electronExecutable,
    args: packagedExecutable ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      AUTO_CODEZ_VISUAL_TEST: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    timeout: 60000,
  });

  page = await electronApp.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => pageErrors.push(errorText(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.rail-button[data-panel="chats"]').waitFor({ state: 'visible' });
  await page.locator('.rail-button[data-panel="projects"]').waitFor({ state: 'visible' });
  await page.locator('.rail-button[data-panel="plugins"]').waitFor({ state: 'visible' });
  await page.locator('.terminal-rail-button').waitFor({ state: 'visible' });
  await page.locator('.api-key-rail-button').waitFor({ state: 'visible' });
  await page.locator('#ac-app-settings').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: '*{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}',
  });
  await assertHealthy();

  await step('aba-home-chats', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-panel="chats"]').click();
    await waitForText('.panel-title', 'Chats');
  });

  await step('aba-projetos', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-panel="projects"]').click();
    await waitForText('.panel-title', 'Projetos');
  });

  await step('aba-plugins', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-panel="plugins"]').click();
    await waitForText('.panel-title', 'Plugins');
  });

  await step('aba-terminal', async () => {
    await closeTransientUi();
    await page.locator('.terminal-rail-button').click();
    await page.locator('.terminal-panel.open').waitFor({ state: 'visible' });
    await waitForText('.terminal-title', 'TERMINAL');
    await page.waitForFunction(async () => {
      const api = window.autoCodez?.terminal;
      if (!api) return false;
      const sessions = await api.listSessions();
      return Array.isArray(sessions) && sessions.length > 0;
    }, null, { timeout: 15000 });
  });

  await step('aba-api-keys', async () => {
    await closeTransientUi();
    await page.locator('.api-key-rail-button').click();
    await page.locator('.api-key-manager-backdrop').waitFor({ state: 'visible' });
    await waitForText('#api-key-manager-title', 'API Keys');
  });

  await closeTransientUi();

  await step('aba-perfil', async () => {
    await page.locator('.rail-button[data-action="profile"]').click();
    await page.locator('.profile-overlay').waitFor({ state: 'visible' });
    await waitForText('.profile-header h1', 'Perfil');
  });

  await closeTransientUi();

  await step('aba-configuracoes-geral', async () => {
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await waitForText('.settings-section-header h2', 'Geral');
  });

  const settingsSections = [
    ['ai', 'Inteligência', 'aba-configuracoes-inteligencia'],
    ['editor', 'Editor', 'aba-configuracoes-editor'],
    ['terminal', 'Terminal', 'aba-configuracoes-terminal'],
    ['security', 'Segurança', 'aba-configuracoes-seguranca'],
    ['sync', 'Sincronização', 'aba-configuracoes-sincronizacao'],
  ];

  for (const [id, title, name] of settingsSections) {
    await step(name, async () => {
      const overlay = page.locator('.settings-overlay');
      if (!(await overlay.count())) {
        await page.locator('#ac-app-settings').click();
        await overlay.waitFor({ state: 'visible' });
      }
      await page.locator(`[data-settings-section="${id}"]`).click();
      await waitForText('.settings-section-header h2', title);
    });
  }

  await closeTransientUi();

  const manifest = {
    generatedAt: new Date().toISOString(),
    executable: packagedExecutable ? 'packaged' : 'development-runtime',
    platform: process.platform,
    arch: process.arch,
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })),
    results,
    pageErrors,
    consoleErrors,
  };

  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'console-errors.txt'), `${consoleErrors.join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'page-errors.txt'), `${pageErrors.join('\n')}\n`, 'utf8');

  const failed = results.filter((item) => item.status === 'failed');
  if (pageErrors.length || failed.length) {
    throw new Error(`Fluxo visual falhou: ${failed.length} etapa(s) com falha e ${pageErrors.length} page error(s).`);
  }
}

main()
  .catch(async (error) => {
    const message = errorText(error);
    console.error(error);
    await writeDiagnostic('fatal-error.txt', message).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    if (watchdog) clearTimeout(watchdog);
    await closeElectronSafely();
  });
