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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error('Porta CDP inválida.'));
      });
    });
  });
}

async function prepareState() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-account-ui-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
}

function environment() {
  const env = {
    ...process.env,
    HOME: stateRoot,
    AUTO_CODEZ_VISUAL_TEST: '1',
    AUTO_CODEZ_DESCOPE_PROJECT_ID: 'P2abcDEF_123',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  }
  return env;
}

async function startElectron() {
  const cdpPort = await reservePort();
  appProcess = spawn(
    executable,
    [
      '--remote-debugging-port=' + cdpPort,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
    ],
    {
      cwd: root,
      env: environment(),
      windowsHide: true,
      stdio: 'ignore',
    },
  );

  const endpoint = 'http://127.0.0.1:' + cdpPort;
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
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });

  const login = page.locator('[data-account-screen="login"]');
  await login.waitFor({ state: 'visible', timeout: 20_000 });

  await login.getByRole('heading', { name: 'Bem-vindo ao Auto CodeZ', exact: true }).waitFor();
  await login.getByLabel('Magic Link', { exact: true }).waitFor();
  await login.getByRole('button', { name: 'Enviar link', exact: true }).waitFor();
  await login.getByRole('button', { name: 'Continuar com GitHub', exact: true }).waitFor();
  await login.getByRole('button', { name: 'Continuar com Google', exact: true }).waitFor();
  await login.getByRole('button', { name: 'Continuar com Microsoft', exact: true }).waitFor();
  await login.getByRole('button', { name: /Entrar com passkey/i }).waitFor();

  const bodyText = await login.textContent();
  for (const method of ['GitHub', 'Google', 'Microsoft', 'passkey', 'Magic Link']) {
    if (!bodyText?.includes(method)) {
      throw new Error('Método nativo ausente no onboarding: ' + method);
    }
  }

  if (await login.getByRole('button', { name: 'Entrar ou criar conta', exact: true }).count()) {
    throw new Error('O onboarding regrediu para a tela hospedada genérica.');
  }

  await page.screenshot({
    path: path.join(outputDir, 'funcional-account-login.png'),
    animations: 'disabled',
  });

  if (pageErrors.length || consoleErrors.length) {
    throw new Error(
      'Erros no renderer: page=' + JSON.stringify(pageErrors) +
      ' console=' + JSON.stringify(consoleErrors),
    );
  }

  await fs.writeFile(
    path.join(outputDir, 'account-login.json'),
    JSON.stringify({ pageErrors, consoleErrors }, null, 2) + '\n',
    'utf8',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await delay(250);
  killTree(appProcess?.pid);
  if (stateRoot) {
    await fs.rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 150,
    }).catch(() => {});
  }
});
