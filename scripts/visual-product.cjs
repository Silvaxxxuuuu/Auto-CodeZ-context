const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const packagedExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const executable = packagedExecutable || require('electron');
const VIEWPORT = { width: 1440, height: 900 };
const COMPACT_VIEWPORT = { width: 1008, height: 689 };
const results = [];
const pageErrors = [];
const consoleErrors = [];
let stateRoot;
let appProcess;
let appExit;
let browser;
let page;
let stderr = '';

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar uma porta CDP.'));
        else resolve(port);
      });
    });
  });
}

async function prepareStateRoot() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-product-visual-'));
  if (process.platform === 'win32') {
    await Promise.all([
      fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true }),
      fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true }),
    ]);
  } else {
    await Promise.all([
      fs.mkdir(path.join(stateRoot, '.config'), { recursive: true }),
      fs.mkdir(path.join(stateRoot, '.cache'), { recursive: true }),
    ]);
  }
}

function environment() {
  const env = {
    ...process.env,
    AUTO_CODEZ_VISUAL_TEST: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    HOME: stateRoot,
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  } else {
    env.XDG_CONFIG_HOME = path.join(stateRoot, '.config');
    env.XDG_CACHE_HOME = path.join(stateRoot, '.cache');
  }
  return env;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function startElectron() {
  const cdpPort = await reservePort();
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ];
  if (!packagedExecutable) args.push('.');
  appProcess = spawn(executable, args, {
    cwd: root,
    env: environment(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  appProcess.stderr?.setEncoding('utf8');
  appProcess.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-256 * 1024); });
  appProcess.once('exit', (code, signal) => { appExit = { code, signal }; });

  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (appExit) throw new Error(`Electron encerrou antes do CDP: ${JSON.stringify(appExit)}\n${stderr}`);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      if (!context) throw new Error('Contexto Chromium indisponível.');
      page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) || await context.waitForEvent('page', { timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await delay(300);
    }
  }
  throw new Error(`Renderer não ficou disponível: ${errorText(lastError)}`);
}

async function screenshot(name) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outputDir, `${name}.png`), animations: 'disabled' });
}

async function assertHealthy() {
  const marker = page.locator('#auto-codez-module-failures');
  if (await marker.count()) throw new Error((await marker.first().innerText()).trim() || 'Falha de inicialização de módulo.');
}

async function assertNoHorizontalOverflow() {
  const metrics = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  if (metrics.document > 1 || metrics.body > 1) throw new Error(`Overflow horizontal: document=${metrics.document}px body=${metrics.body}px.`);
}

async function assertScrollable(selector) {
  const metrics = await page.locator(selector).evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  if (metrics.scrollHeight <= metrics.clientHeight + 1) throw new Error(`${selector} deveria ser scrollável no viewport compacto.`);
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
    await screenshot(`falha-${name}`).catch(() => {});
  }
}

async function clickIfVisible(selector) {
  const locator = page.locator(selector).first();
  if (await locator.count() && await locator.isVisible().catch(() => false)) await locator.click().catch(() => {});
}

async function closeTransientUi() {
  await clickIfVisible('.api-key-manager-close');
  await clickIfVisible('[data-profile-close]');
  await clickIfVisible('[data-settings-close]');
  await clickIfVisible('#terminal-close');
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(100);
}

async function waitForText(selector, text) {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 15_000 });
}

async function ensureSettings() {
  const overlay = page.locator('.settings-overlay');
  if (!(await overlay.count())) {
    await page.locator('#ac-app-settings').click();
    await overlay.waitFor({ state: 'visible' });
  }
}

async function selectSettingsSection(id, title) {
  await ensureSettings();
  await page.locator(`[data-settings-section="${id}"]`).click();
  await waitForText('.settings-section-header h2', title);
}

async function stopTerminalSessions() {
  if (!page || page.isClosed()) return;
  await page.evaluate(async () => {
    const terminal = window.autoCodez?.terminal;
    if (!terminal) return;
    const sessions = await terminal.listSessions();
    for (const session of sessions) {
      if (session.status === 'running') await terminal.kill(session.id).catch(() => {});
    }
  }).catch(() => {});
}

async function runScenarios() {
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
      const terminal = window.autoCodez?.terminal;
      if (!terminal) return false;
      const sessions = await terminal.listSessions();
      return Array.isArray(sessions) && sessions.length > 0;
    }, null, { timeout: 15_000 });
  });

  await step('aba-api-keys', async () => {
    await closeTransientUi();
    await page.locator('.api-key-rail-button').click();
    await page.locator('.api-key-manager-backdrop').waitFor({ state: 'visible' });
    await waitForText('#api-key-manager-title', 'API Keys');
  });

  await step('aba-perfil-produto', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-action="profile"]').click();
    await page.locator('.profile-overlay').waitFor({ state: 'visible' });
    await waitForText('.profile-header h1', 'Perfil');
    await waitForText('.profile-content', 'Seu espaço de trabalho');
    const text = (await page.locator('.profile-content').innerText()).replace(/\s+/g, ' ');
    for (const expected of ['Ambiente de IA', 'Este dispositivo', 'Google', 'GitHub', 'Microsoft', 'Passkeys', 'Magic Link']) {
      if (!text.includes(expected)) throw new Error(`Perfil não exibiu ${expected}.`);
    }
  });

  await step('funcional-perfil-persistencia', async () => {
    const overlay = page.locator('.profile-overlay');
    if (!(await overlay.count())) {
      await page.locator('.rail-button[data-action="profile"]').click();
      await overlay.waitFor({ state: 'visible' });
    }
    const input = page.locator('[data-profile-name-input]');
    await input.fill('Visual Test');
    await page.locator('[data-profile-local-form] .profile-primary-button').click();
    await waitForText('[data-profile-save-state]', 'Perfil salvo neste dispositivo.');
    await page.locator('[data-profile-close]').click();
    await page.locator('.rail-button[data-action="profile"]').click();
    await page.locator('.profile-overlay').waitFor({ state: 'visible' });
    if ((await page.locator('[data-profile-name-input]').inputValue()) !== 'Visual Test') throw new Error('Nome local não persistiu.');
    await page.locator('[data-profile-name-input]').fill('Usuário local');
    await page.locator('[data-profile-local-form] .profile-primary-button').click();
    await waitForText('[data-profile-save-state]', 'Perfil salvo neste dispositivo.');
  });

  await step('funcional-inteligencia-persistencia', async () => {
    await closeTransientUi();
    await page.locator('.rail-button[data-panel="chats"]').click();
    await page.locator('.new-item').filter({ hasText: 'Novo chat' }).first().click();
    const selected = page.locator('.chat-item.selected[data-chat]');
    await selected.waitFor({ state: 'visible' });
    const chatId = await selected.getAttribute('data-chat');
    if (!chatId) throw new Error('Chat visual não recebeu id.');
    await page.locator('#intelligence-button').click();
    await page.locator('.intelligence-menu').waitFor({ state: 'visible' });
    await page.locator('[data-intelligence-option="high"]').click();
    await waitForText('.intelligence-current', 'Alto');
    await page.waitForFunction(async (id) => {
      const state = await window.autoCodez.getState();
      return state.chats.some((chat) => chat.id === id && chat.intelligence === 'high');
    }, chatId, { timeout: 15_000 });
  });

  await step('configuracoes-sem-editor-generico', async () => {
    await closeTransientUi();
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await waitForText('.settings-section-header h2', 'IA e modelos');
    if (await page.locator('[data-settings-section="editor"]').count()) throw new Error('Configurações de Editor reapareceram no produto.');
    const labels = await page.locator('[data-settings-section] strong').allTextContents();
    for (const expected of ['IA e modelos', 'Execução', 'Privacidade', 'Interface']) {
      if (!labels.some((label) => label.trim() === expected)) throw new Error(`Seção ${expected} ausente das Configurações.`);
    }
  });

  await step('funcional-configuracoes-interface-persistencia', async () => {
    await selectSettingsSection('interface', 'Interface');
    await page.locator('[data-settings-control="density"]').selectOption('compact');
    await page.waitForFunction(() => document.documentElement.dataset.acDensity === 'compact');
    const animation = page.locator('[data-settings-control="animations"]');
    if (!(await animation.isChecked())) throw new Error('Animações deveriam iniciar ativadas no estado isolado.');
    await animation.locator('..').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('ac-reduced-motion'));
    await page.locator('[data-settings-close]').click();
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await selectSettingsSection('interface', 'Interface');
    if ((await page.locator('[data-settings-control="density"]').inputValue()) !== 'compact') throw new Error('Densidade não persistiu.');
    if (await page.locator('[data-settings-control="animations"]').isChecked()) throw new Error('Preferência de movimento não persistiu.');
    await page.locator('[data-settings-control="density"]').selectOption('comfortable');
    await page.locator('[data-settings-control="animations"]').locator('..').click();
    await page.waitForFunction(() => document.documentElement.dataset.acDensity === 'comfortable' && !document.documentElement.classList.contains('ac-reduced-motion'));
  });

  await step('configuracoes-ia-modelos', async () => {
    await selectSettingsSection('ai', 'IA e modelos');
    const intelligence = page.locator('[data-settings-control="chat-intelligence"]');
    await intelligence.waitFor({ state: 'visible' });
    if ((await intelligence.inputValue()) !== 'high') throw new Error('Configurações não refletiram a Inteligência persistida pelo chat.');
  });

  await step('configuracoes-execucao', async () => {
    await selectSettingsSection('execution', 'Execução');
    const permission = page.locator('[data-settings-control="chat-permission"]');
    await permission.waitFor({ state: 'visible' });
    await permission.selectOption('ask');
    const chatId = await page.locator('.chat-item.selected[data-chat]').getAttribute('data-chat');
    if (!chatId) throw new Error('Chat selecionado desapareceu durante Execução.');
    await page.waitForFunction(async (id) => {
      const state = await window.autoCodez.getState();
      return state.chats.some((chat) => chat.id === id && chat.permissionLevel === 'ask');
    }, chatId, { timeout: 15_000 });
    const text = (await page.locator('.settings-body').innerText()).replace(/\s+/g, ' ');
    for (const expected of ['Aprovação obrigatória', 'Allowed Paths', 'Shadow workspace']) {
      if (!text.includes(expected)) throw new Error(`Proteção de execução ausente: ${expected}.`);
    }
  });

  await step('configuracoes-privacidade', async () => {
    await selectSettingsSection('privacy', 'Privacidade');
    const text = (await page.locator('.settings-body').innerText()).replace(/\s+/g, ' ');
    for (const expected of ['Credenciais de IA', 'Secrets do projeto', 'Local-first']) {
      if (!text.includes(expected)) throw new Error(`Proteção de privacidade ausente: ${expected}.`);
    }
  });

  await step('configuracoes-ia-local-sem-runtime', async () => {
    await ensureSettings();
    const localAi = page.locator('[data-local-ai-settings]');
    await localAi.waitFor({ state: 'visible', timeout: 10_000 });
    await localAi.click();
    await waitForText('.settings-section-header h2', 'IA Local');
    await waitForText('.settings-body', 'Seu computador');
  });

  await closeTransientUi();
  await page.setViewportSize(COMPACT_VIEWPORT);
  await page.waitForTimeout(150);

  await step('compact-home-chats', async () => {
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

  await step('compact-configuracoes', async () => {
    await closeTransientUi();
    await page.locator('#ac-app-settings').click();
    await page.locator('.settings-overlay').waitFor({ state: 'visible' });
    await waitForText('.settings-section-header h2', 'IA e modelos');
    const metrics = await page.locator('.settings-overlay').evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
    if (metrics.scrollHeight < metrics.clientHeight) throw new Error('Métricas inválidas da tela compacta de Configurações.');
  });
}

async function writeManifest() {
  const manifest = {
    generatedAt: new Date().toISOString(),
    executable: packagedExecutable ? 'packaged' : 'development-runtime',
    transport: 'cdp',
    isolatedState: true,
    platform: process.platform,
    arch: process.arch,
    targetViewport: VIEWPORT,
    compactViewport: COMPACT_VIEWPORT,
    results,
    pageErrors,
    consoleErrors,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'page-errors.txt'), `${pageErrors.join('\n')}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'console-errors.txt'), `${consoleErrors.join('\n')}\n`, 'utf8');
}

async function cleanup() {
  await stopTerminalSessions();
  if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await delay(300);
  if (appProcess?.pid && !appExit) killTree(appProcess.pid);
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
}

(async () => {
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
    await prepareStateRoot();
    await startElectron();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => pageErrors.push(errorText(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.setViewportSize(VIEWPORT);
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '*{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}' });
    await assertHealthy();
    await runScenarios();
    await writeManifest();
    const failed = results.filter((result) => result.status === 'failed');
    if (failed.length || pageErrors.length || consoleErrors.length) {
      throw new Error(`Fluxo visual falhou: ${failed.length} etapa(s), ${pageErrors.length} page error(s), ${consoleErrors.length} console error(s).`);
    }
  } catch (error) {
    await writeManifest().catch(() => {});
    await fs.writeFile(path.join(outputDir, 'fatal-error.txt'), `${errorText(error)}\n${stderr}\n`, 'utf8').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
