const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const electronExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const manifestPath = path.join(outputDir, 'manifest.json');
const testName = 'funcional-plugin-platform';
let stateRoot;
let bridgeServer;
let bridgePort;
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
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Não foi possível reservar uma porta.')));
    });
  });
}

async function startBridgeServer() {
  bridgeServer = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, source: 'visual-plugin-bridge' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    bridgeServer.once('error', reject);
    bridgeServer.listen(0, '127.0.0.1', () => {
      const address = bridgeServer.address();
      bridgePort = address && typeof address === 'object' ? address.port : 0;
      if (!bridgePort || bridgePort < 1024) reject(new Error('Bridge visual recebeu porta inválida.'));
      else resolve();
    });
  });
}

function pluginSource() {
  return `autoCodez.register({
  async activate(api) {
    const bridge = await api.bridge.request({ url: 'http://127.0.0.1:${bridgePort}/health' });
    if (!bridge || bridge.status !== 200 || !String(bridge.body || '').includes('visual-plugin-bridge')) throw new Error('Bridge local não respondeu corretamente.');
    await api.settings.set('visual-mode', 'verified');
    const stored = await api.settings.get('visual-mode');
    if (stored !== 'verified') throw new Error('Settings do plugin não persistiram.');
    await api.tools.register([{
      id: 'external_action',
      description: 'Execute a bounded action in the connected visual test application.',
      risk: 'write',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
        additionalProperties: false
      }
    }]);
    const job = await api.jobs.begin('Validando Plugin Platform');
    await api.jobs.update(job.id, { progress: 0.5, activity: 'Sandbox e bridge validados' });
    await api.jobs.complete(job.id, 'Runtime concluído');
    await api.activity.publish('Sandbox, settings, jobs, tools e bridge validados.', 'completed');
  },
  async deactivate(api) {
    await api.activity.clear();
  },
  async invoke(method, payload) {
    if (method !== 'external_action') throw new Error('Método de plugin desconhecido.');
    return {
      ok: true,
      target: payload && payload.input ? payload.input.target : null,
      chatId: payload && payload.context ? payload.context.chatId : null
    };
  }
});\n`;
}

async function createPluginPackage(base) {
  const pluginRoot = path.join(base, 'plugins', 'visual.plugin');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify({
    apiVersion: 1,
    id: 'visual.plugin',
    name: 'Visual Sandbox Plugin',
    version: '1.0.0',
    description: 'Fixture real para validar lifecycle, grants, sandbox e capabilities.',
    publisher: 'Auto CodeZ CI',
    main: 'index.js',
    contributions: ['tool'],
    permissions: ['network:localhost', 'background:run', 'ai:tool'],
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'index.js'), pluginSource(), 'utf8');
}

async function prepareStateRoot() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugin-platform-'));
  if (process.platform === 'win32') {
    const roaming = path.join(stateRoot, 'AppData', 'Roaming');
    const local = path.join(stateRoot, 'AppData', 'Local');
    await Promise.all([fs.mkdir(roaming, { recursive: true }), fs.mkdir(local, { recursive: true })]);
    await Promise.all([
      createPluginPackage(path.join(roaming, 'Auto CodeZ')),
      createPluginPackage(path.join(roaming, 'auto-codez')),
    ]);
  } else {
    const config = path.join(stateRoot, '.config');
    const cache = path.join(stateRoot, '.cache');
    await Promise.all([fs.mkdir(config, { recursive: true }), fs.mkdir(cache, { recursive: true })]);
    await Promise.all([
      createPluginPackage(path.join(config, 'Auto CodeZ')),
      createPluginPackage(path.join(config, 'auto-codez')),
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
  while (Date.now() < deadline) {
    if (exitState) throw new Error(`Electron encerrou antes do CDP: ${JSON.stringify(exitState)}\n${stderr}`);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      if (!context) throw new Error('Contexto Chromium indisponível.');
      page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) || await context.waitForEvent('page', { timeout: 5000 });
      return;
    } catch {
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error('CDP não ficou disponível.');
}

async function updateManifest(result) {
  let manifest = { results: [], pageErrors: [], consoleErrors: [] };
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {}
  manifest.results = Array.isArray(manifest.results) ? manifest.results.filter((item) => item?.name !== testName) : [];
  manifest.results.push(result);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function runTest() {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(errorText(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const failures = page.locator('#auto-codez-module-failures');
  if (await failures.count()) throw new Error((await failures.first().innerText()).trim());

  await page.locator('.rail-button[data-panel="plugins"]').click();
  await page.locator('.plugin-platform-summary').waitFor({ state: 'visible', timeout: 15_000 });
  const card = page.locator('[data-plugin-id="visual.plugin"]');
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  if (!((await card.innerText()).includes('Visual Sandbox Plugin'))) throw new Error('Plugin fixture não foi descoberto.');
  if (!((await card.innerText()).includes('0/3 permissões'))) throw new Error('Grants iniciais do plugin não estão fechados por padrão.');

  await card.locator('[data-plugin-permissions="visual.plugin"]').first().click();
  const modal = page.locator('.plugin-permission-modal');
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  const permissions = modal.locator('[data-plugin-permission-value]');
  if (await permissions.count() !== 3) throw new Error('Modal não exibiu as três capabilities solicitadas.');
  for (let index = 0; index < await permissions.count(); index += 1) await permissions.nth(index).check();
  await modal.locator('[data-plugin-save-permissions="visual.plugin"]').click();
  await modal.waitFor({ state: 'detached', timeout: 10_000 });

  await card.locator('[data-plugin-enable="visual.plugin"]').waitFor({ state: 'visible', timeout: 10_000 });
  await card.locator('[data-plugin-enable="visual.plugin"]').click();
  await card.locator('.plugin-platform-status.healthy').waitFor({ state: 'visible', timeout: 20_000 });
  await card.getByText('Sandbox, settings, jobs, tools e bridge validados.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });

  const sandbox = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe[aria-hidden="true"]')];
    const frame = frames.find((item) => item.getAttribute('sandbox')?.includes('allow-scripts'));
    return frame ? {
      count: frames.length,
      sandbox: frame.getAttribute('sandbox'),
      hidden: frame.hidden,
    } : null;
  });
  if (!sandbox || sandbox.hidden !== true || sandbox.sandbox !== 'allow-scripts') {
    throw new Error(`Sandbox visual não está restrito a allow-scripts: ${JSON.stringify(sandbox)}`);
  }

  await page.screenshot({ path: path.join(outputDir, 'funcional-plugin-platform.png'), animations: 'disabled' });

  await card.locator('[data-plugin-disable="visual.plugin"]').click();
  await card.getByText('Desativado', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('iframe[aria-hidden="true"]')].some((frame) => frame.getAttribute('sandbox')?.includes('allow-scripts')));
  await page.screenshot({ path: path.join(outputDir, 'funcional-plugin-platform-desativado.png'), animations: 'disabled' });

  if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  if (bridgeServer) await new Promise((resolve) => bridgeServer.close(resolve)).catch(() => {});
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await startBridgeServer();
    await prepareStateRoot();
    await startElectron();
    await runTest();
    await updateManifest({ name: testName, status: 'passed' });
  } catch (error) {
    const message = errorText(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, `falha-${testName}.png`), animations: 'disabled', fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'plugin-platform-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
