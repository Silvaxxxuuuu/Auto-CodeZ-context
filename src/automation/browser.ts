import { execFile } from 'node:child_process';

export type BrowserName =
  | 'chrome'
  | 'msedge'
  | 'brave'
  | 'firefox'
  | 'opera'
  | 'opera_gx'
  | 'vivaldi';

export type BrowserTab = {
  browser: BrowserName;
  processId: number;
  handle: number;
  title: string;
  selected: boolean;
};

export type AiBrowserProvider =
  | 'chatgpt'
  | 'claude'
  | 'gemini';

type PowerShellResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

const browserProcesses: BrowserName[] = [
  'chrome',
  'msedge',
  'brave',
  'firefox',
  'opera',
  'opera_gx',
  'vivaldi',
];

const messageInputTerms: Record<AiBrowserProvider, string[]> = {
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

const forbiddenInputTerms = [
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
  timeout = 10000,
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
        maxBuffer: 20 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

function parseBrowserProcessName(value: string): BrowserName {
  const normalized = value.toLowerCase();

  if (normalized === 'msedge') {
    return 'msedge';
  }

  if (normalized === 'opera_gx') {
    return 'opera_gx';
  }

  return normalized as BrowserName;
}

function scoreTab(
  tab: BrowserTab,
  searchTerms: string[],
): number {
  const title = tab.title.toLowerCase();
  let score = tab.selected ? 100 : 0;

  for (const term of searchTerms) {
    const normalized = term.toLowerCase();

    if (title === normalized) {
      score += 80;
      continue;
    }

    if (title.includes(normalized)) {
      score += 30;
    }

    if (
      normalized.includes('.') &&
      title.includes(normalized)
    ) {
      score += 25;
    }
  }

  return score;
}

export async function findAiTab(
  searchTerms: string[],
): Promise<BrowserTab | null> {
  if (searchTerms.length === 0) {
    return null;
  }

  const browserNames = createPowerShellArray(browserProcesses);
  const terms = createPowerShellArray(searchTerms);

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$browserNames = @(${browserNames})
$terms = @(${terms})
$results = @()

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
    $root = [System.Windows.Automation.AutomationElement]::FromHandle(
      $process.MainWindowHandle
    )

    if ($null -eq $root) {
      continue
    }

    $tabsCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem
    )

    $tabs = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $tabsCondition
    )

    foreach ($tab in $tabs) {
      try {
        $name = [string]$tab.Current.Name

        if ([string]::IsNullOrWhiteSpace($name)) {
          continue
        }

        $matched = $false

        foreach ($term in $terms) {
          if ($name.ToLowerInvariant().Contains($term.ToLowerInvariant())) {
            $matched = $true
            break
          }
        }

        if (-not $matched) {
          continue
        }

        $selected = $false

        try {
          $selection = $tab.GetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern
          )

          if ($null -ne $selection) {
            $selected = [bool]$selection.Current.IsSelected
          }
        }
        catch {
        }

        $results += [PSCustomObject]@{
          browser = [string]$process.ProcessName
          processId = [int]$process.Id
          handle = [int64]$process.MainWindowHandle
          title = $name
          selected = $selected
        }
      }
      catch {
      }
    }
  }
  catch {
  }
}

$results | ConvertTo-Json -Compress -Depth 5
`;

  const result = await runPowerShell(script, 7000);

  if (!result.success || !result.stdout.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    const items = Array.isArray(parsed) ? parsed : [parsed];

    const tabs = items
      .filter(
        (item) =>
          item &&
          Number(item.handle) > 0 &&
          typeof item.title === 'string',
      )
      .map<BrowserTab>((item) => ({
        browser: parseBrowserProcessName(String(item.browser || '')),
        processId: Number(item.processId),
        handle: Number(item.handle),
        title: String(item.title || ''),
        selected: Boolean(item.selected),
      }));

    tabs.sort(
      (a, b) =>
        scoreTab(b, searchTerms) -
        scoreTab(a, searchTerms),
    );

    return tabs[0] || null;
  }
  catch {
    return null;
  }
}

export async function waitForAiTab(
  searchTerms: string[],
  attempts = 30,
  delayMs = 500,
): Promise<BrowserTab | null> {
  const totalAttempts = Math.max(1, attempts);
  const delay = Math.max(0, delayMs);

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const tab = await findAiTab(searchTerms);

    if (tab) {
      return tab;
    }

    if (attempt < totalAttempts - 1 && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
}

export async function focusBrowserTab(
  tab: BrowserTab,
): Promise<boolean> {
  return selectBrowserTab(tab);
}

export async function selectBrowserTab(
  tab: BrowserTab,
): Promise<boolean> {
  if (!tab.handle || tab.handle <= 0) {
    return false;
  }

  const escapedTitle = escapePowerShellString(tab.title.toLowerCase());

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AutoCodeZBrowserSelect {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    public const int SW_RESTORE = 9;
}
"@

$handle = [IntPtr]::new(${tab.handle})
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)

if ($null -eq $root) {
  Write-Output "false"
  exit
}

$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)

$tabs = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  $condition
)

$matched = $false

foreach ($candidate in $tabs) {
  try {
    $name = [string]$candidate.Current.Name

    if (-not $name.ToLowerInvariant().Contains('${escapedTitle}')) {
      continue
    }

    try {
      $selection = $candidate.GetCurrentPattern(
        [System.Windows.Automation.SelectionItemPattern]::Pattern
      )

      if ($null -ne $selection) {
        $selection.Select()
        $matched = $true
      }
    }
    catch {
      try {
        if ($candidate.Current.IsEnabled) {
          $matched = $true
        }
      }
      catch {
      }
    }

    break
  }
  catch {
  }
}

if ([AutoCodeZBrowserSelect]::IsIconic($handle)) {
  [AutoCodeZBrowserSelect]::ShowWindowAsync(
    $handle,
    [AutoCodeZBrowserSelect]::SW_RESTORE
  ) | Out-Null
}

[AutoCodeZBrowserSelect]::SetForegroundWindow($handle) | Out-Null

if ($matched) {
  Write-Output "true"
}
else {
  Write-Output "false"
}
`;

  const result = await runPowerShell(script, 7000);

  return (
    result.success &&
    result.stdout.trim().toLowerCase() === 'true'
  );
}

export async function focusBrowserMessageInput(
  tab: BrowserTab,
  provider: AiBrowserProvider,
): Promise<boolean> {
  const terms = createPowerShellArray(
    messageInputTerms[provider],
  );
  const forbidden = createPowerShellArray(
    forbiddenInputTerms,
  );

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${tab.handle})
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$terms = @(${terms})
$forbidden = @(${forbidden})

if ($null -eq $root) {
  Write-Output "false"
  exit
}

$condition = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Document
  )),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text
  ))
)

$elements = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  $condition
)

$candidates = @()

foreach ($element in $elements) {
  try {
    $current = $element.Current

    if (-not $current.IsEnabled -or $current.IsOffscreen) {
      continue
    }

    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    $helpText = [string]$current.HelpText
    $controlType = [string]$current.ControlType.ProgrammaticName
    $className = [string]$current.ClassName
    $evidence = "$name $automationId $helpText $controlType $className".ToLowerInvariant()

    $blocked = $false

    foreach ($term in $forbidden) {
      if ($evidence.Contains($term.ToLowerInvariant())) {
        $blocked = $true
        break
      }
    }

    if ($blocked) {
      continue
    }

    $score = 0

    foreach ($term in $terms) {
      if ($evidence.Contains($term.ToLowerInvariant())) {
        $score += 100
      }
    }

    if ($controlType.ToLowerInvariant().Contains('document')) {
      $score += 20
    }

    if ($controlType.ToLowerInvariant().Contains('edit')) {
      $score += 20
    }

    if ($evidence.Contains('contenteditable')) {
      $score += 15
    }

    if ($evidence.Contains('textbox')) {
      $score += 15
    }

    if ($score -gt 0) {
      $candidates += [PSCustomObject]@{
        element = $element
        score = $score
      }
    }
  }
  catch {
  }
}

$candidates = @(
  $candidates |
  Sort-Object -Property score -Descending
)

foreach ($candidate in $candidates) {
  try {
    $candidate.element.SetFocus()
    Start-Sleep -Milliseconds 80

    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement

    if ($null -eq $focused) {
      continue
    }

    $focusedCurrent = $focused.Current
    $focusedEvidence = (
      [string]$focusedCurrent.Name + ' ' +
      [string]$focusedCurrent.AutomationId + ' ' +
      [string]$focusedCurrent.HelpText + ' ' +
      [string]$focusedCurrent.ControlType.ProgrammaticName + ' ' +
      [string]$focusedCurrent.ClassName
    ).ToLowerInvariant()

    $focusedBlocked = $false

    foreach ($term in $forbidden) {
      if ($focusedEvidence.Contains($term.ToLowerInvariant())) {
        $focusedBlocked = $true
        break
      }
    }

    if ($focusedBlocked) {
      continue
    }

    $focusedMatches = $false

    foreach ($term in $terms) {
      if ($focusedEvidence.Contains($term.ToLowerInvariant())) {
        $focusedMatches = $true
        break
      }
    }

    if ($focusedMatches -or $candidate.score -ge 100) {
      Write-Output "true"
      exit
    }
  }
  catch {
  }
}

Write-Output "false"
`;

  const result = await runPowerShell(script, 7000);

  return (
    result.success &&
    result.stdout.trim().toLowerCase() === 'true'
  );
}

export async function pasteClipboardAndSend(
  expectedPrompt = '',
  _tab?: BrowserTab,
  provider?: AiBrowserProvider,
): Promise<boolean> {
  const terms = provider
    ? createPowerShellArray(messageInputTerms[provider])
    : '';
  const forbidden = createPowerShellArray(forbiddenInputTerms);
  const escapedPrompt = escapePowerShellString(expectedPrompt);

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$terms = @(${terms})
$forbidden = @(${forbidden})
$expectedPrompt = '${escapedPrompt}'

try {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement

  if ($null -eq $focused) {
    Write-Output "false"
    exit
  }

  $current = $focused.Current
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

  if ($terms.Count -gt 0) {
    $matched = $false

    foreach ($term in $terms) {
      if ($evidence.Contains($term.ToLowerInvariant())) {
        $matched = $true
        break
      }
    }

    if (-not $matched) {
      Write-Output "false"
      exit
    }
  }

  $shell = New-Object -ComObject WScript.Shell
  Start-Sleep -Milliseconds 80
  $shell.SendKeys("^v")
  Start-Sleep -Milliseconds 180

  if (-not [string]::IsNullOrWhiteSpace($expectedPrompt)) {
    $verified = $false

    try {
      $valuePattern = $focused.GetCurrentPattern(
        [System.Windows.Automation.ValuePattern]::Pattern
      )

      if ($null -ne $valuePattern) {
        $value = [string]$valuePattern.Current.Value
        $verified = $value.Contains($expectedPrompt)
      }
    }
    catch {
    }

    if (-not $verified) {
      try {
        $textPattern = $focused.GetCurrentPattern(
          [System.Windows.Automation.TextPattern]::Pattern
        )

        if ($null -ne $textPattern) {
          $text = [string]$textPattern.DocumentRange.GetText(-1)
          $verified = $text.Contains($expectedPrompt)
        }
      }
      catch {
      }
    }

    if (-not $verified) {
      Write-Output "false"
      exit
    }
  }

  $shell.SendKeys("{ENTER}")
  Start-Sleep -Milliseconds 100
  Write-Output "true"
}
catch {
  Write-Output "false"
}
`;

  const result = await runPowerShell(script, 5000);

  return (
    result.success &&
    result.stdout.trim().toLowerCase() === 'true'
  );
}
