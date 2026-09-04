import { execFile } from 'node:child_process';

import type {
  AiBrowserProvider,
  BrowserTab,
} from './browser';

type PowerShellResult = {
  success: boolean;
  stdout: string;
};

const providerTerms: Record<AiBrowserProvider, string[]> = {
  chatgpt: [
    'chat with chatgpt',
    'ask anything',
    'prompt-textarea',
    'chat input',
  ],
  claude: [
    'write a message',
    'message claude',
    'what can i help you with',
    'what can i help you with today',
    "what's something you're working on right now",
    'type your message here',
  ],
  gemini: [
    'enter a prompt here',
    'ask gemini',
    'chat with gemini',
    'gemini prompt',
  ],
};

const forbiddenTerms = [
  'address',
  'search',
  'find',
  'url',
  'omnibox',
  'navigation',
  'navigate',
  'web search',
];

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function createPowerShellArray(values: string[]): string {
  return values
    .map((value) => `'${escapePowerShellString(value)}'`)
    .join(',');
}

function runPowerShell(
  script: string,
): Promise<PowerShellResult> {
  return new Promise((resolve) => {
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
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5000,
      },
      (error, stdout) => {
        resolve({
          success: !error,
          stdout: stdout || '',
        });
      },
    );
  });
}

export async function verifyFocusedAiMessageInput(
  tab: BrowserTab,
  provider: AiBrowserProvider,
): Promise<boolean> {
  const terms = createPowerShellArray(providerTerms[provider]);
  const forbidden = createPowerShellArray(forbiddenTerms);

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${tab.handle})
$terms = @(${terms})
$forbidden = @(${forbidden})

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement

  if ($null -eq $root -or $null -eq $focused) {
    Write-Output "false"
    exit
  }

  $rootRuntimeId = [string]::Join(',', $root.GetRuntimeId())
  $cursor = $focused
  $insideRoot = $false

  for ($depth = 0; $depth -lt 20 -and $null -ne $cursor; $depth++) {
    try {
      $cursorRuntimeId = [string]::Join(',', $cursor.GetRuntimeId())

      if ($cursorRuntimeId -eq $rootRuntimeId) {
        $insideRoot = $true
        break
      }

      $cursor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cursor)
    }
    catch {
      $cursor = $null
    }
  }

  if (-not $insideRoot) {
    Write-Output "false"
    exit
  }

  $cursor = $focused

  for ($depth = 0; $depth -lt 12 -and $null -ne $cursor; $depth++) {
    $current = $cursor.Current
    $evidence = (
      [string]$current.Name + ' ' +
      [string]$current.AutomationId + ' ' +
      [string]$current.HelpText + ' ' +
      [string]$current.ControlType.ProgrammaticName + ' ' +
      [string]$current.ClassName
    ).ToLowerInvariant()

    foreach ($term in $forbidden) {
      if ($evidence.Contains($term.ToLowerInvariant())) {
        Write-Output "false"
        exit
      }
    }

    foreach ($term in $terms) {
      if ($evidence.Contains($term.ToLowerInvariant())) {
        if ($current.IsEnabled -and $current.IsKeyboardFocusable) {
          Write-Output "true"
          exit
        }
      }
    }

    try {
      $cursor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cursor)
    }
    catch {
      $cursor = $null
    }
  }

  Write-Output "false"
}
catch {
  Write-Output "false"
}
`;

  const result = await runPowerShell(script);

  return (
    result.success &&
    result.stdout.trim().toLowerCase() === 'true'
  );
}
