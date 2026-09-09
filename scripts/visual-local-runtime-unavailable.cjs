const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const executable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
if (!executable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE é obrigatório.');

let stateRoot;
let appProcess;
let browser;
let page;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Porta CDP inválida.')));
    });
  });
}

async function prepareState() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-runtime-unavailable-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
}

function environment() {
  const env = { ...process.env, HOME: stateRoot, AUTO_CODEZ_VISUAL_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  }
  return env;
}

async function startElectron() {
  const cdpPort = await reservePort();
  appProcess = spawn(executable, [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--no-first-run'], {
    cwd: root,
    env: environment(),
    windowsHide: true,
    stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      page = context?.pages().find((candidate) => !candidate.url().startsWith('devtools://'));
      if (!page && context) page = await context.waitForEvent('page', { timeout: 5000 });
      if (page) return;
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await delay(300);
    }
  }
  throw lastError || new Error('Renderer indisponível.');
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await prepareState();
  await startElectron();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });

  const created = await page.evaluate(() => window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'safe' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const chat = page.locator(`[data-chat="${created.id}"]`).first();
  await chat.waitFor({ state: 'visible', timeout: 15_000 });
  await chat.click();
  await page.locator(`[data-chat-settings="${created.id}"]`).click({ force: true });

  const ai = page.locator('#chat-available-ai');
  await ai.waitFor({ state: 'visible' });
  await ai.selectOption('provider:lm-studio');
  const model = page.locator('#chat-model');
  await model.locator('option[value="qwen3-0.6b-q4-k-m"]').waitFor({ state: 'attached', timeout: 15_000 });
  if (await model.isDisabled()) throw new Error('O catálogo LM Studio ficou escondido quando o runtime estava desligado.');
  const optionTexts = await model.locator('option').allTextContents();
  if (!optionTexts.some((text) => /recomendado/i.test(text))) throw new Error(`Nenhuma recomendação LM Studio apareceu: ${JSON.stringify(optionTexts)}`);

  const state = page.locator('#chat-local-model-state');
  await state.getByText('LM Studio precisa estar com o servidor local ativo', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await state.locator('[data-local-runtime-retry]').waitFor({ state: 'visible' });
  const disabledInstall = state.getByRole('button', { name: 'Instalar modelo', exact: true });
  await disabledInstall.waitFor({ state: 'visible' });
  if (!(await disabledInstall.isDisabled())) throw new Error('Instalar modelo não pode ficar ativo com o LM Studio desligado.');
  if (!(await page.locator('#save-available-ai-settings').isDisabled())) throw new Error('Salvar ficou ativo sem modelo local instalado.');

  await page.screenshot({ path: path.join(outputDir, 'funcional-lm-studio-runtime-desligado.png'), animations: 'disabled' });
  if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  await fs.writeFile(path.join(outputDir, 'local-runtime-unavailable.json'), `${JSON.stringify({ pageErrors, consoleErrors, optionTexts }, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await delay(250);
  killTree(appProcess?.pid);
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
});
