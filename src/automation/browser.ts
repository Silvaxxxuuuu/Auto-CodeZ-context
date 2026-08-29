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

type PowerShellResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

const browserProcesses:
  BrowserName[] = [
    'chrome',
    'msedge',
    'brave',
    'firefox',
    'opera',
    'opera_gx',
    'vivaldi',
  ];

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
        `'${escapePowerShellString(
          value,
        )}'`,
    )
    .join(',');
}

function runPowerShell(
  script: string,
  timeout = 10000,
): Promise<PowerShellResult> {
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

export async function findAiTab(
  searchTerms: string[],
): Promise<BrowserTab | null> {
  if (
    searchTerms.length === 0
  ) {
    return null;
  }

  const browserNames =
    createPowerShellArray(
      browserProcesses,
    );

  const terms =
    createPowerShellArray(
      searchTerms,
    );

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$browserNames = @(${browserNames})
$terms = @(${terms})

$processes = @(
  Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $browserNames -contains $_.ProcessName
  }
)

$results = @()

foreach ($process in $processes) {
  if (
    $process.MainWindowHandle -eq 0
  ) {
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

    $tabsCondition =
      New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem
      )

    $tabs =
      $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $tabsCondition
      )

    foreach ($tab in $tabs) {
      try {
        $name =
          [string]$tab.Current.Name

        if (
          [string]::IsNullOrWhiteSpace($name)
        ) {
          continue
        }

        foreach ($term in $terms) {
          if (
            $name.ToLowerInvariant().Contains(
              $term.ToLowerInvariant()
            )
          ) {
            $results += [PSCustomObject]@{
              browser = [string]$process.ProcessName
              processId = [int]$process.Id
              handle = [int64]$process.MainWindowHandle
              title = $name
              selected = [bool]$false
            }

            break
          }
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

  const result =
    await runPowerShell(
      script,
      7000,
    );

  if (
    !result.success ||
    !result.stdout.trim()
  ) {
    return null;
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

    const first =
      items.find(
        (item) =>
          item &&
          Number(
            item.handle,
          ) > 0,
      );

    if (!first) {
      return null;
    }

    return {
      browser:
        String(
          first.browser || '',
        ).toLowerCase() as BrowserName,
      processId:
        Number(
          first.processId,
        ),
      handle:
        Number(
          first.handle,
        ),
      title:
        String(
          first.title || '',
        ),
      selected:
        Boolean(
          first.selected,
        ),
    };
  } catch {
    return null;
  }
}

export async function focusBrowserTab(
  tab: BrowserTab,
): Promise<boolean> {
  return selectBrowserTab(
    tab,
  );
}

export async function selectBrowserTab(
  tab: BrowserTab,
): Promise<boolean> {
  if (
    !tab.handle ||
    tab.handle <= 0
  ) {
    return false;
  }

  const escapedTitle =
    escapePowerShellString(
      tab.title.toLowerCase(),
    );

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AutoCodeZBrowserSelect {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(
        IntPtr hWnd
    );

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

$handle =
  [IntPtr]::new(${tab.handle})

$root =
  [System.Windows.Automation.AutomationElement]::FromHandle(
    $handle
  )

if ($null -eq $root) {
  Write-Output "false"
  exit
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

$matched = $false

foreach ($candidate in $tabs) {
  try {
    $name =
      [string]$candidate.Current.Name

    if (
      -not $name.ToLowerInvariant().Contains(
        '${escapedTitle}'
      )
    ) {
      continue
    }

    try {
      $selection =
        $candidate.GetCurrentPattern(
          [System.Windows.Automation.SelectionItemPattern]::Pattern
        )

      if ($null -ne $selection) {
        $selection.Select()
        $matched = $true
      }
    }
    catch {
    }

    break
  }
  catch {
  }
}

if (
  [AutoCodeZBrowserSelect]::IsIconic(
    $handle
  )
) {
  [AutoCodeZBrowserSelect]::ShowWindowAsync(
    $handle,
    [AutoCodeZBrowserSelect]::SW_RESTORE
  ) | Out-Null
}

[AutoCodeZBrowserSelect]::SetForegroundWindow(
  $handle
) | Out-Null

if ($matched) {
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

export async function focusBrowserInput(
  tab: BrowserTab,
): Promise<boolean> {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle =
  [IntPtr]::new(${tab.handle})

$root =
  [System.Windows.Automation.AutomationElement]::FromHandle(
    $handle
  )

if ($null -eq $root) {
  Write-Output "false"
  exit
}

$condition =
  New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit
    )),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document
    ))
  )

$elements =
  $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )

foreach ($element in $elements) {
  try {
    $current =
      $element.Current

    if (
      -not $current.IsEnabled
    ) {
      continue
    }

    if (
      $current.IsOffscreen
    ) {
      continue
    }

    try {
      $element.SetFocus()

      Write-Output "true"
      exit
    }
    catch {
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

export async function pasteClipboardAndSend(): Promise<boolean> {
  const script = `
try {
  $shell =
    New-Object -ComObject WScript.Shell

  Start-Sleep -Milliseconds 50

  $shell.SendKeys("^v")

  Start-Sleep -Milliseconds 120

  $shell.SendKeys("{ENTER}")

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