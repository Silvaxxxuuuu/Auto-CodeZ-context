const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const executable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const EXPECTED_PROVIDERS = new Map([
  ['groq', 'Groq'],
  ['deepseek', 'DeepSeek'],
  ['xai', 'xAI'],
  ['mistral', 'Mistral AI'],
  ['openrouter', 'OpenRouter'],
  ['together', 'Together AI'],
  ['fireworks', 'Fireworks AI'],
  ['cerebras', 'Cerebras'],
  ['huggingface', 'Hugging Face'],
]);

if (!executable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE é obrigatório para o teste visual de providers.');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        else if (!port) reject(new Error('Não foi possível reservar uma porta CDP.'));
        else resolve(port);
      });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function main() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-provider-visual-'));
  await fs.mkdir(outputDir, { recursive: true });
  if (process.platform === 'win32') {
    await Promise.all([
      fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true }),
      fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true }),
    ]);
  }

  const cdpPort = await reservePort();
  const env = { ...process.env, HOME: stateRoot, AUTO_CODEZ_VISUAL_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  }

  const child = spawn(executable, [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: 'ignore',
  });

  let browser;
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  try {
    const endpoint = `http://127.0.0.1:${cdpPort}`;
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
        const context = browser.contexts()[0];
        page = context?.pages().find((candidate) => !candidate.url().startsWith('devtools://'));
        if (!page && context) page = await context.waitForEvent('page', { timeout: 5000 });
        if (page) break;
      } catch (error) {
        lastError = error;
        if (browser) await browser.close().catch(() => {});
        browser = undefined;
        await delay(300);
      }
    }
    if (!page) throw lastError || new Error('Renderer não ficou disponível via CDP.');

    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.api-key-rail-button').click();
    await page.locator('.api-key-manager-backdrop').waitFor({ state: 'visible' });
    const addButton = page.locator('.api-key-manager-add');
    await addButton.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const button = document.querySelector('.api-key-manager-add');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await addButton.click();
    await page.locator('.api-key-manager-form.open').waitFor({ state: 'visible' });
    const options = await page.locator('#api-key-provider option').evaluateAll((items) => items.map((item) => ({
      id: item instanceof HTMLOptionElement ? item.value : '',
      name: item.textContent?.trim() || '',
    })));
    const actual = new Map(options.map((option) => [option.id, option.name]));
    for (const [id, name] of EXPECTED_PROVIDERS) {
      if (actual.get(id) !== name) throw new Error(`Provider ausente ou incorreto no seletor: ${id} (${actual.get(id) || 'ausente'}).`);
    }
    if (pageErrors.length || consoleErrors.length) {
      throw new Error(`Erros no renderer: page=${pageErrors.length}, console=${consoleErrors.length}.`);
    }

    await page.screenshot({ path: path.join(outputDir, 'funcional-api-key-provider-catalog.png'), animations: 'disabled' });
    await fs.writeFile(path.join(outputDir, 'provider-catalog.json'), `${JSON.stringify({
      checkedAt: new Date().toISOString(),
      expected: Object.fromEntries(EXPECTED_PROVIDERS),
      actual: Object.fromEntries(actual),
      pageErrors,
      consoleErrors,
    }, null, 2)}\n`, 'utf8');
  } finally {
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await delay(400);
    killTree(child.pid);
    await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
