import { execFile } from 'node:child_process';

export type WindowsUiElement = {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  framework: string;
  enabled: boolean;
  offscreen: boolean;
};

type PowerShellResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

function escapePowerShellString(
  value: string,
): string {
  return value.replace(
    /'/g,
    "''",
  );
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

export async function focusWindow(
  handle: number,
): Promise<boolean> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0
  ) {
    return false;
  }

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AutoCodeZWindow {
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

$handle = [IntPtr]::new(${handle})

if ($handle -eq [IntPtr]::Zero) {
  Write-Output "false"
  exit
}

try {
  if (
    [AutoCodeZWindow]::IsIconic($handle)
  ) {
    [AutoCodeZWindow]::ShowWindowAsync(
      $handle,
      [AutoCodeZWindow]::SW_RESTORE
    ) | Out-Null
  }

  [AutoCodeZWindow]::SetForegroundWindow(
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

export async function inspectWindow(
  handle: number,
): Promise<WindowsUiElement[]> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0
  ) {
    return [];
  }

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${handle})

$root =
  [System.Windows.Automation.AutomationElement]::FromHandle(
    $handle
  )

if ($null -eq $root) {
  exit
}

$condition =
  New-Object System.Windows.Automation.TrueCondition

$elements =
  $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )

$result = @()

foreach ($element in $elements) {
  try {
    $current = $element.Current

    $result += [PSCustomObject]@{
      name = [string]$current.Name
      automationId = [string]$current.AutomationId
      controlType = [string]$current.ControlType.ProgrammaticName
      className = [string]$current.ClassName
      framework = [string]$current.FrameworkId
      enabled = [bool]$current.IsEnabled
      offscreen = [bool]$current.IsOffscreen
    }
  }
  catch {
  }
}

$result | ConvertTo-Json -Compress -Depth 10
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
          typeof item.name ===
            'string',
      )
      .map(
        (item) => ({
          name:
            item.name || '',
          automationId:
            item.automationId ||
            '',
          controlType:
            item.controlType ||
            '',
          className:
            item.className ||
            '',
          framework:
            item.framework ||
            '',
          enabled:
            Boolean(
              item.enabled,
            ),
          offscreen:
            Boolean(
              item.offscreen,
            ),
        }),
      );
  } catch {
    return [];
  }
}

export async function findWindowHandleByTitle(
  titleTerms: string[],
): Promise<number | null> {
  if (
    titleTerms.length === 0
  ) {
    return null;
  }

  const terms =
    titleTerms
      .map(
        escapePowerShellString,
      )
      .map(
        (term) =>
          `'${term}'`,
      )
      .join(',');

  const script = `
$terms = @(${terms})

foreach (
  $process in
  Get-Process -ErrorAction SilentlyContinue
) {
  try {
    if (
      $process.MainWindowHandle -eq 0
    ) {
      continue
    }

    $title =
      [string]$process.MainWindowTitle

    if (
      [string]::IsNullOrWhiteSpace($title)
    ) {
      continue
    }

    foreach ($term in $terms) {
      if (
        $title.ToLowerInvariant().Contains(
          $term.ToLowerInvariant()
        )
      ) {
        Write-Output (
          [int64]$process.MainWindowHandle
        )

        exit
      }
    }
  }
  catch {
  }
}
`;

  const result =
    await runPowerShell(
      script,
      5000,
    );

  if (
    !result.success
  ) {
    return null;
  }

  const value =
    Number(
      result.stdout.trim(),
    );

  return Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}

export async function focusFirstEditableElement(
  handle: number,
): Promise<boolean> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0
  ) {
    return false;
  }

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${handle})

$root =
  [System.Windows.Automation.AutomationElement]::FromHandle(
    $handle
  )

if ($null -eq $root) {
  Write-Output "false"
  exit
}

$editCondition =
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
    $editCondition
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

export async function setElementValue(
  handle: number,
  value: string,
): Promise<boolean> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0
  ) {
    return false;
  }

  const escapedValue =
    escapePowerShellString(
      value,
    );

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${handle})
$value = '${escapedValue}'

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
    if (
      $element.Current.IsEnabled -eq $false
    ) {
      continue
    }

    try {
      $pattern =
        $element.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        )

      if ($null -ne $pattern) {
        $pattern.SetValue($value)
        Write-Output "true"
        exit
      }
    }
    catch {
    }

    try {
      $legacy =
        $element.GetCurrentPattern(
          [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern
        )

      if ($null -ne $legacy) {
        $legacy.SetValue($value)
        Write-Output "true"
        exit
      }
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

export async function sendEnter(
  handle: number,
): Promise<boolean> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0
  ) {
    return false;
  }

  const focused =
    await focusWindow(
      handle,
    );

  if (!focused) {
    return false;
  }

  const script = `
try {
  $shell =
    New-Object -ComObject WScript.Shell

  Start-Sleep -Milliseconds 40

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

export async function readWindowText(
  handle: number,
): Promise<string[]> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0
  ) {
    return [];
  }

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${handle})

$root =
  [System.Windows.Automation.AutomationElement]::FromHandle(
    $handle
  )

if ($null -eq $root) {
  exit
}

$condition =
  New-Object System.Windows.Automation.TrueCondition

$elements =
  $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )

$result = @()

foreach ($element in $elements) {
  try {
    $current =
      $element.Current

    $name =
      [string]$current.Name

    if (
      -not [string]::IsNullOrWhiteSpace($name)
    ) {
      $result += $name
    }

    try {
      $pattern =
        $element.GetCurrentPattern(
          [System.Windows.Automation.TextPattern]::Pattern
        )

      if ($null -ne $pattern) {
        $document =
          $pattern.DocumentRange

        $text =
          $document.GetText(-1)

        if (
          -not [string]::IsNullOrWhiteSpace($text)
        ) {
          $result += $text
        }
      }
    }
    catch {
    }

    try {
      $value =
        $element.GetCurrentPropertyValue(
          [System.Windows.Automation.AutomationElement]::ValuePatternProperty
        )

      if (
        $null -ne $value -and
        $value -ne [System.Windows.Automation.AutomationElement]::NotSupported
      ) {
        $text =
          [string]$value

        if (
          -not [string]::IsNullOrWhiteSpace($text)
        ) {
          $result += $text
        }
      }
    }
    catch {
    }
  }
  catch {
  }
}

$result | ConvertTo-Json -Compress -Depth 5
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
    return [];
  }

  try {
    const parsed =
      JSON.parse(
        result.stdout.trim(),
      );

    return Array.isArray(parsed)
      ? parsed.filter(
          (item) =>
            typeof item ===
            'string',
        )
      : typeof parsed ===
          'string'
        ? [parsed]
        : [];
  } catch {
    return [];
  }
}