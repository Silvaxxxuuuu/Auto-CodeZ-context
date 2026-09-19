const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const packagedExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const electronExecutable = packagedExecutable || require('electron');
const VISUAL_WATCHDOG_MS = 6 * 60 * 1000;
const CDP_CONNECT_TIMEOUT_MS = 60 * 1000;
const CLOSE_TIMEOUT_MS = 10 * 1000;
const PROCESS_LOG_LIMIT = 512 * 1024;
const VISUAL_VIEWPORT = { width: 1440, height: 900 };
const COMPACT_VIEWPORT = { width: 1008, height: 689 };

const results = [];
const pageErrors = [];
const consoleErrors = [];
let browser;
let page;
let appProcess;
let appExit;
let watchdog;
let visualStateRoot;
let electronStdout = '';
let electronStderr = '';

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendProcessLog(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= PROCESS_LOG_LIMIT ? next : next.slice(-PROCESS_LOG_LIMIT);
}

function processExitText() {
  if (!appExit) return 'processo ainda ativo';
  return `code=${String(appExit.code)} signal=${String(appExit.signal)}`;
}

async function writeDiagnostic(name, value) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, name), `${value}\n`, 'utf8');
}

async function writeProcessDiagnostics() {
  await writeDiagnostic('electron-stdout.txt', electronStdout).catch(() => {});
  await writeDiagnostic('electron-stderr.txt', electronStderr).catch(() => {});
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

async function assertNoHorizontalOverflow() {
  const metrics = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  const documentOverflow = metrics.documentScrollWidth - metrics.documentClientWidth;
  const bodyOverflow = metrics.bodyScrollWidth - metrics.bodyClientWidth;
  if (documentOverflow > 1 || bodyOverflow > 1) {
    throw new Error(`Overflow horizontal detectado: document=${documentOverflow}px body=${bodyOverflow}px viewport=${metrics.viewportWidth}px.`);
  }
}

async function assertScrollable(selector) {
  const metrics = await page.locator(selector).evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  if (metrics.scrollHeight <= metrics.clientHeight + 1) {
    throw new Error(`${selector} deveria estar scrollável no viewport compacto, mas scrollHeight=${metrics.scrollHeight}px e clientHeight=${metrics.clientHeight}px.`);
  }
}

async function assertContentReachable(containerSelector, contentSelector) {
  const metrics = await page.evaluate(({ containerSelector, contentSelector }) => {
    const container = document.querySelector(containerSelector);
    const content = document.querySelector(contentSelector);
    if (!(container instanceof HTMLElement) || !(content instanceof HTMLElement)) return null;
    const containerRect = container.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      containerBottom: containerRect.bottom,
      contentBottom: contentRect.bottom,
    };
  }, { containerSelector, contentSelector });
  if (!metrics) throw new Error(`Não foi possível medir ${containerSelector} / ${contentSelector}.`);
  if (metrics.scrollHeight > metrics.clientHeight + 1) return;
  if (metrics.contentBottom > metrics.containerBottom + 1) {
    throw new Error(`${contentSelector} está cortado dentro de ${containerSelector}.`);
  }
}

async function step(name, action) {
  try {
    await action();
    await assertHealthy();
    await assertNoHorizontalOverflow();
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

async function prepareVisualState() {
  visualStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-visual-'));
  if (process.platform === 'win32') {
    await Promise.all([
      fs.mkdir(path.join(visualStateRoot, 'AppData', 'Roaming'), { recursive: true }),
      fs.mkdir(path.join(visualStateRoot, 'AppData', 'Local'), { recursive: true }),
    ]);
  } else {
    await Promise.all([
      fs.mkdir(path.join(visualStateRoot, '.config'), { recursive: true }),
      fs.mkdir(path.join(visualStateRoot, '.cache'), { recursive: true }),
    ]);
  }
}

function visualEnvironment() {
  if (!visualStateRoot) throw new Error('Estado isolado do teste visual ainda não foi preparado.');
  const env = {
    ...process.env,
    AUTO_CODEZ_VISUAL_TEST: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    HOME: visualStateRoot,
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = visualStateRoot;
    env.APPDATA = path.join(visualStateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(visualStateRoot, 'AppData', 'Local');
  } else {
    env.XDG_CONFIG_HOME = path.join(visualStateRoot, '.config');
    env.XDG_CACHE_HOME = path.join(visualStateRoot, '.cache');
  }
  return env;
}

async function cleanupVisualState() {
  if (!visualStateRoot) return;
  await fs.rm(visualStateRoot, { recursive: true, force: true }).catch(() => {});
  visualStateRoot = undefined;
}

async function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar uma porta CDP local.'));
        else resolve(port);
      });
    });
  });
}

async function spawnElectron(cdpPort) {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ];
  if (!packagedExecutable) args.push('.');

  appProcess = spawn(electronExecutable, args, {
    cwd: root,
    env: visualEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  appProcess.stdout?.setEncoding('utf8');
  appProcess.stderr?.setEncoding('utf8');
  appProcess.stdout?.on('data', (chunk) => {
    electronStdout = appendProcessLog(electronStdout, chunk);
  });
  appProcess.stderr?.on('data', (chunk) => {
    electronStderr = appendProcessLog(electronStderr, chunk);
  });
  appProcess.once('exit', (code, signal) => {
    appExit = { code, signal };
  });

  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      appProcess.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      appProcess.off('spawn', onSpawn);
      reject(error);
    };
    appProcess.once('spawn', onSpawn);
    appProcess.once('error', onError);
  });
}

async function connectToRenderer(cdpPort) {
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    if (appExit) {
      const stderr = electronStderr.trim();
      throw new Error(`Electron encerrou antes do CDP ficar disponível (${processExitText()}).${stderr ? `\n${stderr}` : ''}`);
    }

    let candidate;
    try {
      candidate = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = candidate.contexts()[0];
      if (!context) throw new Error('O CDP abriu sem um contexto Chromium padrão.');

      let target = context.pages().find((item) => !item.url().startsWith('devtools://'));
      if (!target) target = await context.waitForEvent('page', { timeout: 5000 });

      browser = candidate;
      page = target;
      return endpoint;
    } catch (error) {
      lastError = error;
      if (candidate) await candidate.close().catch(() => {});
      await delay(350);
    }
  }

  throw new Error(`CDP do Electron não ficou disponível em ${CDP_CONNECT_TIMEOUT_MS}ms. Último erro: ${errorText(lastError)}`);
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
  const pid = appProcess?.pid;
  if (!pid || appExit) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    appProcess.kill('SIGKILL');
  } catch {}
}

async function waitForElectronExit(timeoutMs) {
  if (!appProcess || appExit) return true;
  return new Promise((resolve) => {
    let timer;
    const onExit = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    appProcess.once('exit', onExit);
    timer = setTimeout(() => {
      appProcess.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
  });
}

async function closeElectronSafely() {
  await stopVisualTerminalSessions();

  if (page && !page.isClosed()) {
    await Promise.race([
      page.close({ runBeforeUnload: true }).catch(() => {}),
      delay(2500),
    ]);
  }

  if (browser) await browser.close().catch(() => {});

  const exited = await waitForElectronExit(CLOSE_TIMEOUT_MS);
  if (!exited) {
    forceKillElectronTree();
    await waitForElectronExit(3000);
  }

  await writeProcessDiagnostics();
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  await prepareVisualState();
  await writeDiagnostic('run-started.txt', `Visual run started at ${new Date().toISOString()}`);

  watchdog = setTimeout(async () => {
    await writeDiagnostic('fatal-error.txt', `Visual watchdog exceeded ${VISUAL_WATCHDOG_MS}ms.`).catch(() => {});
    await writeProcessDiagnostics();
    forceKillElectronTree();
    process.exit(1);
  }, VISUAL_WATCHDOG_MS);
  watchdog.unref?.();

  const cdpPort = await reserveTcpPort();
  await spawnElectron(cdpPort);
  const cdpEndpoint = await connectToRenderer(cdpPort);
  await writeDiagnostic('transport.txt', `cdp=${cdpEndpoint}\nmode=${packagedExecutable ? 'packaged' : 'development-runtime'}\nstate=isolated`);

  page.setDefaultTimeout(15000);
  await page.setViewportSize(VISUAL_VIEWPORT);
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
  await assertNoHorizontalOverflow();

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

  await step('funcional-perfil-persistencia', async () => {
    const overlay = page.locator('.profile-overlay');
    if (!(await overlay.count())) {
      await page.locator('.rail-button[data-action="profile"]').click();
      await overlay.waitFor({ state: 'visible' });
    }
    const nameInput = page.locator('[data-profile-name-input]');
    await nameInput.fill('Visual Test');
    await page.locator('[data-profile-local-form] .profile-primary-button').click();
    await waitForText('[data-profile-save-state]', 'Perfil salvo neste dispositivo.');
    await page.locator('[data-profile-close]').click();
    await page.locator('.rail-button[data-action="profile"]').click();
    await page.locator('.profile-overlay').waitFor({ state: 'visible' });
    if ((await page.locator('[data-profile-name-input]').inputValue()) !== 'Visual Test') throw new Error('Nome local não persistiu ao reabrir o Perfil.');
    await waitForText('[data-profile-display-name]', 'Visual Test');
    await page.locator('[data-profile-name-input]').fill('Usuário local');
    await page.locator('[data-profile-local-form] .profile-primary-button').click();
    await waitForText('[data-profile-save-state]', 'Perfil salvo neste dispositivo.');
  });

  await closeTransientUi();

  await step('funcional-inteligencia-persistencia', async () => {
    await page.locator('.rail-button[data-panel="chats"]').click();
    await waitForText('.panel-title', 'Chats');
    await page.locator('.new-item').filter({ hasText: 'Novo chat' }).first().click();
    const selected = page.locator('.chat-item.selected[data-chat]');
    await selected.waitFor({ state: 'visible' });
    const chatId = await selected.getAttribute('data-chat');
    if (!chatId) throw new Error('Novo chat não recebeu identidade no DOM.');
    await page.locator('#intelligence-button').click();
    await page.locator('.intelligence-menu').waitFor({ state: 'visible' });
    await page.locator('[data-intelligence-option="high"]').click();
    await waitForText('.intelligence-current', 'Alto');
    await page.waitForFunction(async (id) => {
      const state = await window.autoCodez?.getState();
      const chats = Array.isArray(state?.chats) ? state.chats : [];
      return chats.some((chat) => chat && typeof chat === 'object' && chat.id === id && chat.intelligence === 'high');
    }, chatId, { timeout: 15000 });
  });

  await step('funcional-configuracoes-persistencia', async () => {
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await waitForText('.settings-section-header h2', 'Geral');
    await page.locator('[data-settings-control="density"]').selectOption('compact');
    await page.waitForFunction(() => document.documentElement.dataset.acDensity === 'compact');
    const animationInput = page.locator('[data-settings-control="animations"]');
    if (!(await animationInput.isChecked())) throw new Error('Animações deveriam começar ativadas no estado visual isolado.');
    await page.locator('.settings-toggle').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('ac-reduced-motion'));
    await page.locator('[data-settings-close]').click();
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    if ((await page.locator('[data-settings-control="density"]').inputValue()) !== 'compact') throw new Error('Densidade não persistiu ao reabrir Settings.');
    if (await page.locator('[data-settings-control="animations"]').isChecked()) throw new Error('Preferência de animações não persistiu ao reabrir Settings.');
    await page.locator('[data-settings-control="density"]').selectOption('comfortable');
    await page.locator('.settings-toggle').click();
    await page.waitForFunction(() => document.documentElement.dataset.acDensity === 'comfortable' && !document.documentElement.classList.contains('ac-reduced-motion'));
    await page.locator('[data-settings-close]').click();
  });

  await step('aba-configuracoes-geral', async () => {
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await waitForText('.settings-section-header h2', 'Geral');
  });

  await step('funcional-configuracoes-chat', async () => {
    await page.locator('[data-settings-section="ai"]').click();
    await waitForText('.settings-section-header h2', 'Inteligência');
    const intelligence = page.locator('[data-settings-control="chat-intelligence"]');
    await intelligence.waitFor({ state: 'visible' });
    if ((await intelligence.inputValue()) !== 'high') throw new Error('Settings não refletiu a Inteligência persistida pelo composer.');
    const permission = page.locator('[data-settings-control="chat-permission"]');
    await permission.selectOption('ask');
    const chatId = await page.locator('.chat-item.selected[data-chat]').getAttribute('data-chat');
    if (!chatId) throw new Error('Chat selecionado desapareceu durante Settings.');
    await page.waitForFunction(async (id) => {
      const state = await window.autoCodez?.getState();
      const chats = Array.isArray(state?.chats) ? state.chats : [];
      return chats.some((chat) => chat && typeof chat === 'object' && chat.id === id && chat.permissionLevel === 'ask' && chat.intelligence === 'high');
    }, chatId, { timeout: 15000 });
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
  await page.setViewportSize(COMPACT_VIEWPORT);
  await page.waitForTimeout(180);

  await step('compact-home-chats', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-panel="chats"]').click();
    await waitForText('.panel-title', 'Chats');
  });

  await step('compact-perfil', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-action="profile"]').click();
    await page.locator('.profile-overlay').waitFor({ state: 'visible' });
    await waitForText('.profile-header h1', 'Perfil');
    await assertScrollable('.profile-overlay');
  });

  await closeTransientUi();

  await step('compact-configuracoes-geral', async () => {
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await waitForText('.settings-section-header h2', 'Geral');
    await assertContentReachable('.settings-overlay', '.settings-page');
  });

  await closeTransientUi();

  const manifest = {
    generatedAt: new Date().toISOString(),
    executable: packagedExecutable ? 'packaged' : 'development-runtime',
    transport: 'cdp',
    isolatedState: true,
    platform: process.platform,
    arch: process.arch,
    targetViewport: VISUAL_VIEWPORT,
    compactViewport: COMPACT_VIEWPORT,
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })),
    results,
    pageErrors,
    consoleErrors,
  };

  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'console-errors.txt'), `${consoleErrors.join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'page-errors.txt'), `${pageErrors.join('\n')}\n`, 'utf8');

  const failed = results.filter((item) => item.status === 'failed');
  if (pageErrors.length || consoleErrors.length || failed.length) {
    throw new Error(`Fluxo visual falhou: ${failed.length} etapa(s) com falha, ${pageErrors.length} page error(s) e ${consoleErrors.length} console error(s).`);
  }
}

main()
  .catch(async (error) => {
    const message = errorText(error);
    console.error(error);
    await writeDiagnostic('fatal-error.txt', `${message}\nElectron: ${processExitText()}`).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    if (watchdog) clearTimeout(watchdog);
    await closeElectronSafely();
    await cleanupVisualState();
  });
