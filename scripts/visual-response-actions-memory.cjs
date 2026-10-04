const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
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

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function start() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-memory-visual-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
  const port = await reservePort();
  const env = {
    ...process.env,
    HOME: stateRoot,
    USERPROFILE: stateRoot,
    APPDATA: path.join(stateRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(stateRoot, 'AppData', 'Local'),
    AUTO_CODEZ_VISUAL_TEST: '1',
    AUTO_CODEZ_VISUAL_ACCOUNT_PROFILE: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };
  appProcess = spawn(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      page = context?.pages().find((candidate) => !candidate.url().startsWith('devtools://'));
      if (!page && context) page = await context.waitForEvent('page', { timeout: 5000 });
      if (page) return;
    } catch {
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error('Renderer indisponível.');
}

async function verifyMemorySettings() {
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(async () => {
    await window.autoCodez.addMemory({
      scopeType: 'global',
      content: 'Memória visual persistente do Auto CodeZ.',
      source: { chatId: 'visual-chat', runId: 'visual-run', messageCreatedAt: 1 },
    });
  });
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible' });
  await page.locator('[data-settings-section="memory"]').click();
  await page.locator('.settings-section-header h2').filter({ hasText: 'Memória' }).waitFor({ state: 'visible' });
  await page.locator('.settings-card').filter({ hasText: 'Memória visual persistente do Auto CodeZ.' }).waitFor({ state: 'visible' });
  const remove = page.locator('[data-memory-delete]').first();
  if (!(await remove.isVisible())) throw new Error('Memória não exibiu ação de remoção.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-configuracoes-memoria.png'), animations: 'disabled' });
}

async function verifyResponseActionsLayout() {
  await page.locator('[data-settings-close]').click();
  await page.evaluate(() => {
    const messages = document.querySelector('#messages');
    if (!messages) throw new Error('Lista de mensagens ausente.');
    const article = document.createElement('article');
    article.className = 'message assistant';
    article.dataset.finalAssistant = 'true';
    article.dataset.messageIndex = '0';
    article.dataset.runId = 'visual-run';
    article.innerHTML = '<div class="message-label">IA visual</div><div class="message-content">Resposta visual para validar a barra de ações.</div>';
    messages.appendChild(article);
  });
  const message = page.locator('.message.assistant[data-run-id="visual-run"]');
  await message.locator('.ac-response-actions').waitFor({ state: 'visible', timeout: 10_000 });
  for (const action of ['copy', 'work', 'memory']) {
    const button = message.locator(`[data-response-action="${action}"]`);
    await button.waitFor({ state: 'visible' });
  }
  if (await message.locator('[data-response-action="retry"]:visible').count()) throw new Error('Retry apareceu sem relatório de execução válido.');
  if (await message.locator('[data-response-action="changes"]:visible').count()) throw new Error('Ver alterações apareceu sem mudanças verificadas.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-barra-acoes-resposta.png'), animations: 'disabled' });
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  try {
    await start();
    await verifyMemorySettings();
    await verifyResponseActionsLayout();
  } finally {
    if (browser) await browser.close().catch(() => {});
    killTree(appProcess?.pid);
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
