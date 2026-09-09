const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const executable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();

if (!executable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE é obrigatório para o teste visual de fontes.');

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

function environment(stateRoot) {
  const env = {
    ...process.env,
    HOME: stateRoot,
    AUTO_CODEZ_VISUAL_TEST: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
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

async function prepareStateRoot() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-sources-visual-'));
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
  return stateRoot;
}

async function launch(stateRoot) {
  const cdpPort = await reservePort();
  const child = spawn(executable, [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ], {
    cwd: root,
    env: environment(stateRoot),
    windowsHide: true,
    stdio: 'ignore',
  });

  let browser;
  let page;
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
  if (!page || !browser) {
    killTree(child.pid);
    throw lastError || new Error('Renderer não ficou disponível via CDP.');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  return { child, browser, page };
}

async function closeSession(session) {
  if (!session) return;
  if (session.page && !session.page.isClosed()) await session.page.close({ runBeforeUnload: true }).catch(() => {});
  if (session.browser) await session.browser.close().catch(() => {});
  await delay(350);
  killTree(session.child?.pid);
  await delay(250);
}

async function findFile(rootPath, fileName) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (!entry.isDirectory()) continue;
    const found = await findFile(fullPath, fileName).catch(() => undefined);
    if (found) return found;
  }
  return undefined;
}

async function main() {
  const stateRoot = await prepareStateRoot();
  await fs.mkdir(outputDir, { recursive: true });
  let first;
  let second;
  try {
    first = await launch(stateRoot);
    const created = await first.page.evaluate(() => window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'read-only' }));
    if (!created?.id) throw new Error('Não foi possível criar o chat de fixture visual.');
    const chatId = created.id;
    await closeSession(first);
    first = undefined;

    const chatsPath = await findFile(stateRoot, 'chats.json');
    if (!chatsPath) throw new Error('chats.json não foi localizado no estado isolado do Electron.');
    const chats = JSON.parse(await fs.readFile(chatsPath, 'utf8'));
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) throw new Error('Chat criado não foi persistido em chats.json.');
    const now = Date.now();
    chat.title = 'Pesquisa atual com IA local';
    chat.providerId = 'ollama';
    chat.model = 'qwen3:8b';
    chat.messages = [
      {
        role: 'user',
        content: 'Pesquise a documentação atual antes de recomendar as ferramentas para este projeto.',
        createdAt: now - 1000,
      },
      {
        role: 'assistant',
        content: 'Consultei fontes públicas atuais antes de montar a recomendação. As referências usadas ficam registradas abaixo da resposta.',
        createdAt: now,
        sources: [
          {
            title: 'Electron Forge — Vite Plugin',
            url: 'https://www.electronforge.io/config/plugins/vite',
            origin: 'autocodez-web',
            citation: 1,
            searchProvider: 'DuckDuckGo',
            retrievedAt: now,
          },
          {
            title: 'TypeScript — Documentation',
            url: 'https://www.typescriptlang.org/docs/',
            origin: 'autocodez-web',
            citation: 2,
            searchProvider: 'DuckDuckGo',
            retrievedAt: now,
          },
          {
            title: 'Destino privado que não pode aparecer',
            url: 'http://127.0.0.1:11434/api/tags',
            origin: 'provider-native',
          },
        ],
      },
    ];
    chat.updatedAt = now;
    await fs.writeFile(chatsPath, `${JSON.stringify(chats, null, 2)}\n`, 'utf8');

    second = await launch(stateRoot);
    const pageErrors = [];
    const consoleErrors = [];
    second.page.on('pageerror', (error) => pageErrors.push(String(error)));
    second.page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const bridgePolicy = await second.page.evaluate(async () => {
      const blocked = [];
      for (const url of ['file:///C:/Users/User/.env', 'http://127.0.0.1:11434/api/tags', 'http://[::1]/']) {
        try {
          await window.autoCodez.openExternal(url);
          blocked.push({ url, rejected: false });
        } catch {
          blocked.push({ url, rejected: true });
        }
      }
      return blocked;
    });
    if (bridgePolicy.some((item) => !item.rejected)) throw new Error(`Bridge externo aceitou destino proibido: ${JSON.stringify(bridgePolicy)}.`);
    const chatItem = second.page.locator(`[data-chat="${chatId}"]`).first();
    await chatItem.waitFor({ state: 'visible', timeout: 15_000 });
    await chatItem.click();
    const sources = second.page.locator('.message.assistant .message-sources');
    await sources.waitFor({ state: 'visible', timeout: 15_000 });
    const cards = second.page.locator('.message.assistant .message-source');
    if (await cards.count() !== 2) throw new Error(`Esperava 2 fontes públicas renderizadas, recebeu ${await cards.count()}.`);
    const titles = await cards.locator('.message-source-title').allTextContents();
    if (!titles.includes('Electron Forge — Vite Plugin') || !titles.includes('TypeScript — Documentation')) {
      throw new Error(`Títulos de fontes inesperados: ${JSON.stringify(titles)}.`);
    }
    const pageText = await sources.innerText();
    if (pageText.includes('Destino privado')) throw new Error('Uma fonte privada foi renderizada na interface.');
    if (!pageText.includes('2 verificadas')) throw new Error(`Contador de fontes incorreto: ${pageText}`);
    if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${pageErrors.length}, console=${consoleErrors.length}.`);
    await second.page.screenshot({ path: path.join(outputDir, 'funcional-fontes-ia-local.png'), animations: 'disabled' });
    await fs.writeFile(path.join(outputDir, 'chat-sources.json'), `${JSON.stringify({ chatId, titles, bridgePolicy, pageErrors, consoleErrors }, null, 2)}\n`, 'utf8');
  } finally {
    await closeSession(first).catch(() => {});
    await closeSession(second).catch(() => {});
    await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
