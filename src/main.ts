import {
  AiConnectorManager,
} from './ai/aiConnectorManager';

import {
  ChatGptConnector,
} from './automation/providers/chatgpt';

import {
  ClaudeConnector,
} from './automation/providers/claude';

import {
  GeminiConnector,
} from './automation/providers/gemini';

import type {
  AiRequest,
} from './ai/aiConnector';
import {
  buildProjectContext,
  serializeProjectContext,
  type ProjectContextInputFile,
} from './core/project-context';
import {
  parseAiResponse,
} from './core/response-parser';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import started from 'electron-squirrel-startup';
import { SessionManager } from './core/session-manager';
import type {
  AiSessionRequest,
} from './core/ai-session';

if (started) {
  app.quit();
}

const aiConnectorManager =
  new AiConnectorManager();

aiConnectorManager.register(
  new ChatGptConnector(),
);

aiConnectorManager.register(
  new ClaudeConnector(),
);

aiConnectorManager.register(
  new GeminiConnector(),
);

const sessionManager =
  new SessionManager(
    aiConnectorManager,
  );

const ignoredDirectories = new Set([
  'node_modules',
  '.git',
  '.vite',
  'dist',
  'build',
  'out',
  'coverage',
]);

let projectRoot: string | null = null;
let mainWindow: BrowserWindow | null = null;

type ClipboardResult = {
  success: boolean;
  content?: string;
  error?: string;
};

type ExternalAiResult = {
  success: boolean;
  mode?: 'application' | 'browser';
  error?: string;
};

type StartApp = {
  name: string;
  appId: string;
};

type DetectedWindow = {
  processName: string;
  processId: number;
  title: string;
  className: string;
  framework: string;
  handle: number;
  controls: AiControl[];
};

type AiControl = {
  name?: string;
  automationId?: string;
  controlType?: string;
  className?: string;
  framework?: string;
  processId?: number;
  enabled?: boolean;
  offscreen?: boolean;
};

const externalAiUrls: Record<string, string> = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app',
};

const providerSearchTerms: Record<string, string[]> = {
  chatgpt: [
    'ChatGPT',
    'chatgpt.com',
    'OpenAI',
  ],
  claude: [
    'Claude',
    'claude.ai',
    'Anthropic',
  ],
  gemini: [
    'Gemini',
    'gemini.google.com',
    'Google Gemini',
  ],
};

const browserProcesses = [
  'chrome',
  'msedge',
  'brave',
  'firefox',
  'opera',
  'opera_gx',
  'vivaldi',
];

sessionManager.onStateChange(
  (change) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }

    mainWindow.webContents.send(
      'ai-session-state',
      {
        sessionId:
          change.sessionId,
        state:
          change.state,
      },
    );
  },
);

sessionManager.on(
  'completed',
  (session) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }

    try {
      const result =
        session.toResult();

      const parsed =
        parseAiResponse(
          result.response.content,
        );

      mainWindow.webContents.send(
        'ai-session-result',
        {
          sessionId:
            result.sessionId,
          provider:
            result.provider,
          response:
            result.response,
          parsed,
        },
      );
    } catch (error) {
      mainWindow.webContents.send(
        'ai-session-error',
        {
          sessionId:
            session.id,
          error:
            error instanceof Error
              ? error.message
              : 'Não foi possível processar a resposta da IA.',
        },
      );
    }
  },
);

sessionManager.on(
  'failed',
  (session) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }

    mainWindow.webContents.send(
      'ai-session-error',
      {
        sessionId:
          session.id,
        error:
          session.error ||
          'A sessão da IA falhou.',
      },
    );
  },
);

function createWindow() {
  mainWindow =
    new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1000,
      minHeight: 650,
      backgroundColor: '#0b0d11',
      webPreferences: {
        preload:
          path.join(
            __dirname,
            'preload.js',
          ),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

  mainWindow.on(
    'closed',
    () => {
      mainWindow = null;
    },
  );

  if (
    MAIN_WINDOW_VITE_DEV_SERVER_URL
  ) {
    mainWindow.loadURL(
      MAIN_WINDOW_VITE_DEV_SERVER_URL,
    );
  } else {
    mainWindow.loadFile(
      path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  }
}

function runPowerShell(
  script: string,
  timeout = 10000,
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise(
    (resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          script,
        ],
        {
          windowsHide: true,
          maxBuffer:
            20 * 1024 * 1024,
          timeout,
        },
        (
          error,
          stdout,
          stderr,
        ) => {
          resolve({
            success:
              !error,
            stdout:
              stdout || '',
            stderr:
              stderr || '',
          });
        },
      );
    },
  );
}

function escapePowerShellString(
  value: string,
): string {
  return value.replace(
    /'/g,
    "''",
  );
}

function createPowerShellArray(
  values: string[],
): string {
  return values
    .map(
      (value) =>
        "'" +
        escapePowerShellString(
          value,
        ) +
        "'",
    )
    .join(',');
}

async function getInstalledStartApps(): Promise<
  StartApp[]
> {
  const script = `
$apps = @(
  Get-StartApps -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -and $_.AppID
  } |
  Select-Object Name, AppID
)

$apps | ConvertTo-Json -Compress -Depth 5
`;

  const result =
    await runPowerShell(
      script,
      5000,
    );

  if (
    !result.success ||
    !result.stdout.trim()
  ) {
    return [];
  }

  try {
    const parsed =
      JSON.parse(
        result.stdout.trim(),
      );

    if (
      Array.isArray(parsed)
    ) {
      return parsed
        .filter(
          (item) =>
            item &&
            typeof item.Name ===
              'string' &&
            typeof item.AppID ===
              'string',
        )
        .map(
          (item) => ({
            name: item.Name,
            appId: item.AppID,
          }),
        );
    }

    if (
      parsed &&
      typeof parsed.Name ===
        'string' &&
      typeof parsed.AppID ===
        'string'
    ) {
      return [
        {
          name: parsed.Name,
          appId: parsed.AppID,
        },
      ];
    }
  } catch {
  }

  return [];
}

async function findInstalledAiApp(
  provider: string,
): Promise<StartApp | null> {
  const terms =
    providerSearchTerms[
      provider
    ] || [];

  if (
    terms.length === 0
  ) {
    return null;
  }

  const apps =
    await getInstalledStartApps();

  const normalizedTerms =
    terms.map(
      (term) =>
        term.toLowerCase(),
    );

  const matches =
    apps.filter(
      (entry) => {
        const name =
          entry.name.toLowerCase();

        return normalizedTerms.some(
          (term) =>
            name === term ||
            name.includes(term),
        );
      },
    );

  if (
    matches.length === 0
  ) {
    return null;
  }

  const exact =
    matches.find(
      (entry) =>
        entry.name
          .toLowerCase() ===
        provider,
    );

  return (
    exact ||
    matches[0]
  );
}

async function getWindowsByTerms(
  terms: string[],
): Promise<
  DetectedWindow[]
> {
  if (
    terms.length === 0
  ) {
    return [];
  }

  const escapedTerms =
    createPowerShellArray(
      terms,
    );

  const script = `
$terms = @(${escapedTerms})

$results = @()

$processes = @(
  Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.MainWindowHandle -ne 0
  }
)

foreach ($process in $processes) {
  try {
    $title = [string]$process.MainWindowTitle
    $processName = [string]$process.ProcessName

    if (
      [string]::IsNullOrWhiteSpace($title)
    ) {
      continue
    }

    $titleLower = $title.ToLowerInvariant()
    $processLower = $processName.ToLowerInvariant()
    $matched = $false

    foreach ($term in $terms) {
      $termLower = $term.ToLowerInvariant()

      if (
        $titleLower.Contains($termLower) -or
        $processLower.Contains($termLower)
      ) {
        $matched = $true
        break
      }
    }

    if (-not $matched) {
      continue
    }

    $results += [PSCustomObject]@{
      processName = $processName
      processId = [int]$process.Id
      title = $title
      handle = [int64]$process.MainWindowHandle
    }
  }
  catch {
  }
}

$results | ConvertTo-Json -Compress -Depth 5
`;

  const result =
    await runPowerShell(
      script,
      5000,
    );

  if (
    !result.success ||
    !result.stdout.trim()
  ) {
    return [];
  }

  try {
    const parsed =
      JSON.parse(
        result.stdout.trim(),
      );

    const items =
      Array.isArray(parsed)
        ? parsed
        : [parsed];

    return items
      .filter(
        (item) =>
          item &&
          typeof item.processName ===
            'string',
      )
      .map(
        (item) => ({
          processName:
            item.processName,
          processId:
            Number(
              item.processId,
            ),
          title:
            item.title || '',
          className: '',
          framework: '',
          handle:
            Number(
              item.handle,
            ),
          controls: [] as AiControl[],
        }),
      );
  } catch {
    return [];
  }
}

async function focusWindowHandle(
  handle: number,
): Promise<boolean> {
  if (
    !handle ||
    handle <= 0
  ) {
    return false;
  }

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AutoCodeZFocus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(
        IntPtr hWnd,
        int nCmdShow
    );

    [DllImport("user32.dll")]
    public static extern bool IsIconic(
        IntPtr hWnd
    );

    public const int SW_RESTORE = 9;
}
"@

$handle = [IntPtr]::new(${handle})

if ($handle -eq [IntPtr]::Zero) {
  Write-Output "false"
  exit
}

try {
  if (
    [AutoCodeZFocus]::IsIconic($handle)
  ) {
    [AutoCodeZFocus]::ShowWindowAsync(
      $handle,
      [AutoCodeZFocus]::SW_RESTORE
    ) | Out-Null
  }

  [AutoCodeZFocus]::SetForegroundWindow(
    $handle
  ) | Out-Null

  Write-Output "true"
}
catch {
  Write-Output "false"
}
`;

  const result =
    await runPowerShell(
      script,
      4000,
    );

  return (
    result.success &&
    result.stdout
      .trim()
      .toLowerCase() ===
      'true'
  );
}

async function focusApplication(
  provider: string,
): Promise<boolean> {
  const terms =
    providerSearchTerms[
      provider
    ] || [];

  const windows =
    await getWindowsByTerms(
      terms,
    );

  for (
    const windowInfo of windows
  ) {
    const focused =
      await focusWindowHandle(
        windowInfo.handle,
      );

    if (focused) {
      return true;
    }
  }

  return false;
}

async function launchWindowsApp(
  appId: string,
): Promise<boolean> {
  if (!appId) {
    return false;
  }

  const escaped =
    escapePowerShellString(
      appId,
    );

  const script = `
$appId = '${escaped}'
$target = "shell:AppsFolder\\$appId"

$launched = $false

try {
  Start-Process -FilePath "explorer.exe" -ArgumentList @($target)
  Start-Sleep -Milliseconds 250
  $launched = $true
}
catch {
}

if (-not $launched) {
  try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.NameSpace("shell:AppsFolder")
    $item = $folder.ParseName($appId)

    if ($null -ne $item) {
      $item.InvokeVerb()
      $launched = $true
    }
  }
  catch {
  }
}

if ($launched) {
  Write-Output "true"
}
else {
  Write-Output "false"
}
`;

  const result =
    await runPowerShell(
      script,
      7000,
    );

  return (
    result.success &&
    result.stdout
      .trim()
      .toLowerCase() ===
      'true'
  );
}

async function waitForApplication(
  provider: string,
  attempts = 20,
  delay = 300,
): Promise<boolean> {
  const terms =
    providerSearchTerms[
      provider
    ] || [];

  for (
    let index = 0;
    index < attempts;
    index++
  ) {
    const windows =
      await getWindowsByTerms(
        terms,
      );

    if (
      windows.length > 0
    ) {
      for (
        const windowInfo of windows
      ) {
        if (
          await focusWindowHandle(
            windowInfo.handle,
          )
        ) {
          return true;
        }
      }

      return true;
    }

    await new Promise<void>(
      (resolve) => {
        setTimeout(
          resolve,
          delay,
        );
      },
    );
  }

  return false;
}

async function findBrowserAiWindow(
  provider: string,
): Promise<boolean> {
  const browserNames =
    createPowerShellArray(
      browserProcesses,
    );

  const terms =
    providerSearchTerms[
      provider
    ] || [];

  const escapedTerms =
    createPowerShellArray(
      terms,
    );

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AutoCodeZBrowser {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(
        IntPtr hWnd,
        int nCmdShow
    );

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    public const int SW_RESTORE = 9;
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$browserNames = @(${browserNames})
$terms = @(${escapedTerms})

$processes = @(
  Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $browserNames -contains $_.ProcessName
  }
)

foreach ($process in $processes) {
  if ($process.MainWindowHandle -eq 0) {
    continue
  }

  try {
    $root =
      [System.Windows.Automation.AutomationElement]::FromHandle(
        $process.MainWindowHandle
      )

    if ($null -eq $root) {
      continue
    }

    $condition =
      New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem
      )

    $tabs =
      $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $condition
      )

    foreach ($tab in $tabs) {
      try {
        $name =
          [string]$tab.Current.Name

        foreach ($term in $terms) {
          if (
            $name -like "*$term*"
          ) {
            try {
              $selectionPattern =
                $tab.GetCurrentPattern(
                  [System.Windows.Automation.SelectionItemPattern]::Pattern
                )

              if (
                $null -ne
                $selectionPattern
              ) {
                $selectionPattern.Select()
              }
            }
            catch {
            }

            if (
              [AutoCodeZBrowser]::IsIconic(
                $process.MainWindowHandle
              )
            ) {
              [AutoCodeZBrowser]::ShowWindowAsync(
                $process.MainWindowHandle,
                [AutoCodeZBrowser]::SW_RESTORE
              ) | Out-Null
            }

            [AutoCodeZBrowser]::SetForegroundWindow(
              $process.MainWindowHandle
            ) | Out-Null

            Write-Output "true"
            exit
          }
        }
      }
      catch {
      }
    }

    foreach ($term in $terms) {
      $windowTitle =
        [string]$root.Current.Name

      if (
        $windowTitle -like "*$term*"
      ) {
        if (
          [AutoCodeZBrowser]::IsIconic(
            $process.MainWindowHandle
          )
        ) {
          [AutoCodeZBrowser]::ShowWindowAsync(
            $process.MainWindowHandle,
            [AutoCodeZBrowser]::SW_RESTORE
          ) | Out-Null
        }

        [AutoCodeZBrowser]::SetForegroundWindow(
          $process.MainWindowHandle
        ) | Out-Null

        Write-Output "true"
        exit
      }
    }
  }
  catch {
  }
}

Write-Output "false"
`;

  const result =
    await runPowerShell(
      script,
      7000,
    );

  return (
    result.success &&
    result.stdout
      .trim()
      .toLowerCase() ===
    'true'
  );
}

async function openBrowser(
  provider: string,
): Promise<boolean> {
  if (
    await findBrowserAiWindow(
      provider,
    )
  ) {
    return true;
  }

  const url =
    externalAiUrls[
      provider
    ];

  if (!url) {
    return false;
  }

  try {
    await shell.openExternal(
      url,
    );

    return true;
  } catch {
    return false;
  }
}

async function openExternalAi(
  provider: string,
): Promise<ExternalAiResult> {
  const url =
    externalAiUrls[provider];

  if (!url) {
    return {
      success: false,
      error:
        'Provedor de IA inválido.',
    };
  }

  try {
    const existingApplication =
      await findInstalledAiApp(
        provider,
      );

    if (existingApplication) {
      try {
        const focused =
          await focusApplication(
            provider,
          );

        if (focused) {
          return {
            success: true,
            mode: 'application',
          };
        }
      } catch {
      }

      try {
        const launched =
          await launchWindowsApp(
            existingApplication.appId,
          );

        if (launched) {
          const ready =
            await waitForApplication(
              provider,
              25,
              300,
            );

          if (ready) {
            return {
              success: true,
              mode: 'application',
            };
          }
        }
      } catch {
      }
    }
  } catch {
  }

  try {
    const browserWindow =
      await findBrowserAiWindow(
        provider,
      );

    if (browserWindow) {
      return {
        success: true,
        mode: 'browser',
      };
    }
  } catch {
  }

  try {
    await shell.openExternal(
      url,
    );

    return {
      success: true,
      mode: 'browser',
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `Não foi possível abrir ${provider}: ${error.message}`
          : `Não foi possível abrir ${provider}.`,
    };
  }
}

ipcMain.handle(
  'create-ai-session',
  async (
    _event,
    request: AiSessionRequest,
  ) => {
    try {
      if (
        !request ||
        typeof request.request !==
          'string' ||
        !request.request.trim()
      ) {
        return {
          success: false,
          error:
            'O pedido do usuário está vazio.',
        };
      }

      const session =
        sessionManager.create(
          request,
        );

      void sessionManager.execute(
        session,
      );

      return {
        success: true,
        sessionId:
          session.id,
        state:
          session.state,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Não foi possível criar a sessão de IA.',
      };
    }
  },
);

ipcMain.handle(
  'cancel-ai-session',
  async (
    _event,
    sessionId: string,
  ) => {
    try {
      return {
        success:
          sessionManager.cancel(
            sessionId,
          ),
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Não foi possível cancelar a sessão.',
      };
    }
  },
);

ipcMain.handle(
  'send-ai-request',
  async (
    _event,
    request: AiRequest,
  ) => {
    try {
      if (
        !request ||
        typeof request.prompt !==
          'string' ||
        !request.prompt.trim()
      ) {
        return {
          success: false,
          error:
            'A solicitação da IA está vazia.',
        };
      }

      clipboard.writeText(
        request.prompt,
      );

      const response =
        await aiConnectorManager.send(
          request,
        );

      return {
        success: true,
        response,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Não foi possível enviar a solicitação para a IA.',
      };
    }
  },
);

ipcMain.handle(
  'open-external-ai',
  async (
    _event,
    provider: string,
  ) => {
    return openExternalAi(
      provider,
    );
  },
);

ipcMain.handle(
  'inspect-external-ai',
  async (
    _event,
    provider: string,
  ) => {
    if (
      !externalAiUrls[
        provider
      ]
    ) {
      return {
        success: false,
        error:
          'Provedor de IA inválido.',
      };
    }

    const installedApp =
      await findInstalledAiApp(
        provider,
      );

    const terms =
      providerSearchTerms[
        provider
      ] || [];

    const detected =
      await getWindowsByTerms(
        terms,
      );

    const browser =
      await findBrowserAiWindow(
        provider,
      );

    const windows =
      detected.map(
        (windowInfo) => ({
          title:
            windowInfo.title,
          processId:
            windowInfo.processId,
          className:
            windowInfo.className,
          framework:
            windowInfo.framework,
          controls:
            windowInfo.controls,
        }),
      );

    return {
      success: true,
      running:
        detected.length > 0 ||
        browser,
      installedApplication:
        installedApp !== null,
      provider,
      appName:
        installedApp?.name,
      appId:
        installedApp?.appId,
      windows,
    };
  },
);

ipcMain.handle(
  'open-folder',
  async () => {
    const result =
      await dialog.showOpenDialog({
        properties: [
          'openDirectory',
        ],
      });

    if (
      result.canceled ||
      result.filePaths.length === 0
    ) {
      return null;
    }

    const folder =
      result.filePaths[0];

    try {
      projectRoot =
        await fs.realpath(
          folder,
        );

      const files =
        await getProjectFiles(
          projectRoot,
        );

      return {
        path: projectRoot,
        files,
      };
    } catch {
      projectRoot = null;

      return {
        path: folder,
        files: [],
      };
    }
  },
);

ipcMain.handle(
  'read-file',
  async (
    _event,
    filePath: string,
  ) => {
    if (
      !(await isPathInsideProject(
        filePath,
      ))
    ) {
      return {
        success: false,
        error:
          'O arquivo está fora do projeto aberto.',
      };
    }

    try {
      const stats =
        await fs.stat(
          filePath,
        );

      if (!stats.isFile()) {
        return {
          success: false,
          error:
            'O caminho selecionado não é um arquivo.',
        };
      }

      if (
        stats.size >
        2 * 1024 * 1024
      ) {
        return {
          success: false,
          error:
            'O arquivo é maior que 2 MB.',
        };
      }

      const content =
        await fs.readFile(
          filePath,
          'utf8',
        );

      return {
        success: true,
        content,
      };
    } catch {
      return {
        success: false,
        error:
          'Não foi possível ler o arquivo.',
      };
    }
  },
);

ipcMain.handle(
  'write-file',
  async (
    _event,
    filePath: string,
    content: string,
  ) => {
    if (
      !(await isPathInsideProject(
        filePath,
      ))
    ) {
      return {
        success: false,
        error:
          'O arquivo está fora do projeto aberto.',
      };
    }

    try {
      const stats =
        await fs.stat(
          filePath,
        );

      if (!stats.isFile()) {
        return {
          success: false,
          error:
            'O caminho selecionado não é um arquivo.',
        };
      }

      if (
        Buffer.byteLength(
          content,
          'utf8',
        ) >
        2 * 1024 * 1024
      ) {
        return {
          success: false,
          error:
            'O conteúdo ultrapassa o limite de 2 MB.',
        };
      }

      await fs.writeFile(
        filePath,
        content,
        'utf8',
      );

      return {
        success: true,
      };
    } catch {
      return {
        success: false,
        error:
          'Não foi possível salvar o arquivo.',
      };
    }
  },
);

ipcMain.handle(
  'write-clipboard',
  async (
    _event,
    text: string,
  ): Promise<ClipboardResult> => {
    try {
      clipboard.writeText(
        text,
      );

      return {
        success: true,
      };
    } catch {
      return {
        success: false,
        error:
          'Não foi possível copiar para o clipboard.',
      };
    }
  },
);

ipcMain.handle(
  'read-clipboard',
  async () => {
    try {
      const content =
        clipboard.readText();

      return {
        success: true,
        content,
      };
    } catch {
      return {
        success: false,
        error:
          'Não foi possível ler o clipboard.',
      };
    }
  },
);

async function getProjectFiles(
  directory: string,
  root: string = directory,
): Promise<
  Array<{
    name: string;
    path: string;
    relativePath: string;
    type: 'file' | 'directory';
  }>
> {
  const entries =
    await fs.readdir(
      directory,
      {
        withFileTypes: true,
      },
    );

  const result: Array<{
    name: string;
    path: string;
    relativePath: string;
    type: 'file' | 'directory';
  }> = [];

  entries.sort((a, b) => {
    if (
      a.isDirectory() &&
      !b.isDirectory()
    ) {
      return -1;
    }

    if (
      !a.isDirectory() &&
      b.isDirectory()
    ) {
      return 1;
    }

    return a.name.localeCompare(
      b.name,
    );
  });

  for (
    const entry of entries
  ) {
    if (
      entry.isDirectory() &&
      ignoredDirectories.has(
        entry.name,
      )
    ) {
      continue;
    }

    const fullPath =
      path.join(
        directory,
        entry.name,
      );

    const relativePath =
      path.relative(
        root,
        fullPath,
      );

    if (
      entry.isDirectory()
    ) {
      result.push({
        name:
          entry.name,
        path:
          fullPath,
        relativePath,
        type:
          'directory',
      });

      const children =
        await getProjectFiles(
          fullPath,
          root,
        );

      result.push(
        ...children,
      );
    } else {
      result.push({
        name:
          entry.name,
        path:
          fullPath,
        relativePath,
        type:
          'file',
      });
    }
  }

  return result;
}

async function isPathInsideProject(
  filePath: string,
): Promise<boolean> {
  if (!projectRoot) {
    return false;
  }

  try {
    const root =
      await fs.realpath(
        projectRoot,
      );

    const target =
      await fs.realpath(
        filePath,
      );

    const relative =
      path.relative(
        root,
        target,
      );

    return (
      relative === '' ||
      (
        !relative.startsWith(
          '..',
        ) &&
        !path.isAbsolute(
          relative,
        )
      )
    );
  } catch {
    const root =
      path.resolve(
        projectRoot,
      );

    const target =
      path.resolve(
        filePath,
      );

    const relative =
      path.relative(
        root,
        target,
      );

    return (
      relative === '' ||
      (
        !relative.startsWith(
          '..',
        ) &&
        !path.isAbsolute(
          relative,
        )
      )
    );
  }
}

ipcMain.handle(
  'build-project-context',
  async (
    _event,
    input: {
      projectRoot: string;
      request: string;
      activeFile: string | null;
      files: ProjectContextInputFile[];
    },
  ) => {
    try {
      const context =
  buildProjectContext({
    rootPath: input.projectRoot,
    activeFile: input.activeFile,
    files: input.files.map(
      (file) => ({
        path: file.path,
        content: file.content,
      }),
    ),
  });

      return {
        success: true,
        context,
        serialized:
          serializeProjectContext(
            context,
          ),
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Não foi possível construir o contexto do projeto.',
      };
    }
  },
);

app.whenReady().then(
  () => {
    createWindow();

    app.on(
      'activate',
      () => {
        if (
          BrowserWindow.getAllWindows()
            .length === 0
        ) {
          createWindow();
        }
      },
    );
  },
);

app.on(
  'window-all-closed',
  () => {
    if (
      process.platform !==
      'darwin'
    ) {
      app.quit();
    }
  },
);