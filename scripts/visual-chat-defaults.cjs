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
const screenshotPath = path.join(outputDir, 'funcional-padroes-novo-chat.png');
const resultPath = path.join(outputDir, 'chat-defaults.json');

let stateRoot;
let appProcess;
let appExit;
let browser;
let page;
let stderr = '';
const pageErrors = [];
const consoleErrors = [];

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-chat-defaults-'));
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
  const port = await reservePort();
  const args = [
    `--remote-debugging-port=${port}`,
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

  const endpoint = `http://127.0.0.1:${port}`;
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
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Renderer não ficou disponível: ${errorText(lastError)}`);
}

async function assertHealthy() {
  const marker = page.locator('#auto-codez-module-failures');
  if (await marker.count()) throw new Error((await marker.first().innerText()).trim() || 'Falha de inicialização de módulo.');
  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  }
}

async function openSettingsSection(id, title) {
  const overlay = page.locator('.settings-overlay');
  if (!(await overlay.count())) {
    await page.locator('#ac-app-settings').click();
    await overlay.waitFor({ state: 'visible', timeout: 15_000 });
  }
  await page.locator(`[data-settings-section="${id}"]`).click();
  await page.locator('.settings-section-header h2').filter({ hasText: title }).waitFor({ state: 'visible', timeout: 15_000 });
}

async function runScenario() {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '*{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}' });
  await assertHealthy();

  await openSettingsSection('ai', 'IA e modelos');
  const intelligenceDefault = page.locator('[data-settings-control="default-intelligence"]');
  await intelligenceDefault.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await intelligenceDefault.inputValue()) !== 'normal') throw new Error('Raciocínio padrão inicial deveria ser normal.');
  await intelligenceDefault.selectOption('maximum');
  await page.locator('[data-settings-control="default-intelligence"]').waitFor({ state: 'visible' });
  if ((await page.locator('[data-settings-control="default-intelligence"]').inputValue()) !== 'maximum') {
    throw new Error('Raciocínio padrão não persistiu após a alteração.');
  }

  await openSettingsSection('execution', 'Execução');
  const permissionDefault = page.locator('[data-settings-control="default-permission"]');
  await permissionDefault.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await permissionDefault.inputValue()) !== 'safe') throw new Error('Autonomia padrão inicial deveria ser safe.');
  await permissionDefault.selectOption('ask');
  await page.locator('[data-settings-control="default-permission"]').waitFor({ state: 'visible' });
  if ((await page.locator('[data-settings-control="default-permission"]').inputValue()) !== 'ask') {
    throw new Error('Autonomia padrão não persistiu após a alteração.');
  }

  await page.locator('[data-settings-close]').click();
  await page.locator('.settings-overlay').waitFor({ state: 'detached', timeout: 15_000 });
  await page.locator('.rail-button[data-panel="chats"]').click();
  await page.locator('.new-item').filter({ hasText: 'Novo chat' }).first().click();

  const selected = page.locator('.chat-item.selected[data-chat]');
  await selected.waitFor({ state: 'visible', timeout: 15_000 });
  const chatId = await selected.getAttribute('data-chat');
  if (!chatId) throw new Error('Novo chat não recebeu id.');

  const created = await page.evaluate(async (id) => {
    const state = await window.autoCodez.getState();
    return state.chats.find((chat) => chat.id === id) || null;
  }, chatId);
  if (!created) throw new Error('Novo chat não apareceu no estado persistido.');
  if (created.intelligence !== 'maximum') throw new Error(`Raciocínio do novo chat incorreto: ${created.intelligence}.`);
  if (created.permissionLevel !== 'ask') throw new Error(`Autonomia do novo chat incorreta: ${created.permissionLevel}.`);

  await page.locator('.intelligence-current').filter({ hasText: 'Máximo' }).waitFor({ state: 'visible', timeout: 15_000 });

  await openSettingsSection('ai', 'IA e modelos');
  const activeIntelligence = page.locator('[data-settings-control="chat-intelligence"]');
  await activeIntelligence.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await activeIntelligence.inputValue()) !== 'maximum') throw new Error('IA e modelos não refletiu o raciocínio herdado pelo novo chat.');

  await openSettingsSection('execution', 'Execução');
  const activePermission = page.locator('[data-settings-control="chat-permission"]');
  await activePermission.waitFor({ state: 'visible', timeout: 15_000 });
  if ((await activePermission.inputValue()) !== 'ask') throw new Error('Execução não refletiu a autonomia herdada pelo novo chat.');

  await assertHealthy();
  await fs.mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  await fs.writeFile(resultPath, `${JSON.stringify({
    checkedAt: new Date().toISOString(),
    chatId,
    intelligence: created.intelligence,
    permissionLevel: created.permissionLevel,
    pageErrors,
    consoleErrors,
  }, null, 2)}\n`, 'utf8');
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (appProcess?.pid && !appExit) killTree(appProcess.pid);
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
}

(async () => {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await prepareStateRoot();
    await startElectron();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => pageErrors.push(errorText(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await runScenario();
  } catch (error) {
    await fs.mkdir(outputDir, { recursive: true }).catch(() => {});
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, 'falha-funcional-padroes-novo-chat.png'), animations: 'disabled' }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'chat-defaults-error.txt'), `${errorText(error)}\n${stderr}\n`, 'utf8').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
