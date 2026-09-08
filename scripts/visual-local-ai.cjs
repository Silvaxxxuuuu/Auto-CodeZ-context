const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const electronExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const manifestPath = path.join(outputDir, 'manifest.json');
const testName = 'funcional-ia-local-ollama';
let stateRoot;
let appProcess;
let browser;
let page;
let exitState;
let stderr = '';

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
        else if (!port) reject(new Error('Não foi possível reservar porta CDP.'));
        else resolve(port);
      });
    });
  });
}

async function createStateRoot() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-local-ai-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
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
  }
  return env;
}

async function startElectron() {
  if (!electronExecutable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE não foi definido.');
  const port = await reservePort();
  appProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ], {
    cwd: root,
    env: environment(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  appProcess.stderr?.setEncoding('utf8');
  appProcess.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-256 * 1024); });
  appProcess.once('exit', (code, signal) => { exitState = { code, signal }; });

  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (exitState) throw new Error(`Electron encerrou antes do CDP: ${JSON.stringify(exitState)}\n${stderr}`);
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
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error(`CDP não ficou disponível: ${errorText(lastError)}`);
}

async function updateManifest(result) {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.results = Array.isArray(manifest.results) ? manifest.results.filter((item) => item?.name !== testName) : [];
  manifest.results.push(result);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function openLocalAiSettings() {
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible' });
  await page.locator('[data-local-ai-settings]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('[data-local-ai-settings]').click();
  await page.locator('[data-local-ai-status]').waitFor({ state: 'visible', timeout: 30_000 });
}

async function runTest() {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(errorText(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#ac-app-settings').waitFor({ state: 'visible' });

  const providerState = await page.evaluate(async () => {
    const state = await window.autoCodez.getState();
    return state.providers.find((provider) => provider.id === 'ollama') || null;
  });
  if (!providerState) throw new Error('Ollama não apareceu no estado de providers.');
  if (providerState.requiresApiKey !== false) throw new Error(`Ollama não está marcado como keyless: ${JSON.stringify(providerState)}`);
  if (providerState.apiKeyConfigured !== false) throw new Error('Ollama não deve declarar API key configurada.');

  await openLocalAiSettings();
  const statusCard = page.locator('[data-local-ai-status]');
  const firstStatus = await statusCard.getAttribute('data-local-ai-status');
  if (firstStatus !== 'connected' && firstStatus !== 'offline') throw new Error(`Estado inesperado da IA local: ${firstStatus}`);
  const bodyText = await page.locator('.settings-body').innerText();
  if (!bodyText.includes('127.0.0.1:11434')) throw new Error('Endpoint local padrão não foi exibido.');
  if (!bodyText.includes('Ollama')) throw new Error('Nome Ollama não foi exibido na aba IA Local.');

  const retry = page.locator('[data-local-ai-action="retry"]');
  await retry.waitFor({ state: 'visible' });
  await retry.click();
  await page.locator('[data-local-ai-status]').waitFor({ state: 'visible', timeout: 30_000 });
  const retriedStatus = await page.locator('[data-local-ai-status]').getAttribute('data-local-ai-status');
  if (retriedStatus !== 'connected' && retriedStatus !== 'offline') throw new Error(`Estado inesperado após retry: ${retriedStatus}`);

  await page.screenshot({ path: path.join(outputDir, `${testName}.png`), animations: 'disabled' });
  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  }
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  try {
    await createStateRoot();
    await startElectron();
    await runTest();
    await updateManifest({ name: testName, status: 'passed' });
  } catch (error) {
    const message = errorText(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, `falha-${testName}.png`), animations: 'disabled' }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'local-ai-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
