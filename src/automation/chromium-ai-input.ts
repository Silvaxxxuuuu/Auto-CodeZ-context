import { execFile } from 'node:child_process';

import type { BrowserTab, AiBrowserProvider } from './browser';

type PowerShellResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

const providerHints: Record<AiBrowserProvider, string[]> = {
  chatgpt: [
    'ask anything',
    'ask chatgpt',
    'chatgpt',
    'openai',
    'prompt',
  ],
  claude: [
    'write a message',
    'reply',
    'claude',
    'anthropic',
    'message',
  ],
  gemini: [
    'enter a prompt here',
    'ask gemini',
    'gemini',
    'google gemini',
    'prompt',
  ],
};

const forbiddenHints = [
  'address and search bar',
  'address and search',
  'omnibox',
  'search the web',
  'search',
  'find in page',
  'find',
  'address bar',
  'url',
  'navigation',
  'navigate',
];

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function createPowerShellArray(values: string[]): string {
  return values.map((value) => `'${escapePowerShellString(value)}'`).join(',');
}

function runPowerShell(script: string, timeout = 10000): Promise<PowerShellResult> {
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

export async function focusAndSendChromiumAiPrompt(
  tab: BrowserTab,
  provider: AiBrowserProvider,
): Promise<boolean> {
  const hints = createPowerShellArray(providerHints[provider]);
  const forbidden = createPowerShellArray(forbiddenHints);

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AutoCodeZChromiumNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(
        IntPtr parent,
        IntPtr childAfter,
        string className,
        string windowName
    );

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(
        IntPtr hWnd,
        uint message,
        IntPtr wParam,
        IntPtr lParam
    );

    public const uint WM_GETOBJECT = 0x003D;
}
"@

$browserHandle = [IntPtr]::new(${tab.handle})
$hints = @(${hints})
$forbidden = @(${forbidden})

if ($browserHandle -eq [IntPtr]::Zero) {
  Write-Output "false"
  exit
}

$renderer = [IntPtr]::Zero
$after = [IntPtr]::Zero

while ($true) {
  $candidate = [AutoCodeZChromiumNative]::FindWindowEx(
    $browserHandle,
    $after,
    'Chrome_RenderWidgetHostHWND1',
    $null
  )

  if ($candidate -eq [IntPtr]::Zero) {
    break
  }

  $renderer = $candidate
  $after = $candidate
}

if ($renderer -eq [IntPtr]::Zero) {
  $after = [IntPtr]::Zero

  while ($true) {
    $candidate = [AutoCodeZChromiumNative]::FindWindowEx(
      $browserHandle,
      $after,
      'Chrome_RenderWidgetHostHWND',
      $null
    )

    if ($candidate -eq [IntPtr]::Zero) {
      break
    }

    $renderer = $candidate
    $after = $candidate
  }
}

if ($renderer -eq [IntPtr]::Zero) {
  Write-Output "false"
  exit
}

[AutoCodeZChromiumNative]::SendMessage(
  $renderer,
  [AutoCodeZChromiumNative]::WM_GETOBJECT,
  [IntPtr]::Zero,
  [IntPtr]::Zero
) | Out-Null

Start-Sleep -Milliseconds 180

$contentRoot = $null

for ($attempt = 0; $attempt -lt 8; $attempt++) {
  try {
    $contentRoot = [System.Windows.Automation.AutomationElement]::FromHandle($renderer)
  }
  catch {
    $contentRoot = $null
  }

  if ($null -ne $contentRoot) {
    try {
      $probe = $contentRoot.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::IsControlElementProperty,
          $true
        ))
      )

      if ($null -ne $probe -and $probe.Count -gt 0) {
        break
      }
    }
    catch {
    }
  }

  Start-Sleep -Milliseconds 220
}

if ($null -eq $contentRoot) {
  Write-Output "false"
  exit
}

$allCondition = New-Object System.Windows.Automation.OrCondition(
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
  )),
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Group
  ))
)

$elements = $contentRoot.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  $allCondition
)

$pageEvidence = $false
$candidates = @()
$rootRect = $contentRoot.Current.BoundingRectangle

foreach ($element in $elements) {
  try {
    $current = $element.Current
    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    $helpText = [string]$current.HelpText
    $className = [string]$current.ClassName
    $frameworkId = [string]$current.FrameworkId
    $controlType = [string]$current.ControlType.ProgrammaticName
    $localizedType = [string]$current.LocalizedControlType
    $evidence = (
      $name + ' ' +
      $automationId + ' ' +
      $helpText + ' ' +
      $className + ' ' +
      $frameworkId + ' ' +
      $controlType + ' ' +
      $localizedType
    ).ToLowerInvariant()

    foreach ($hint in $hints) {
      if ($evidence.Contains($hint.ToLowerInvariant())) {
        $pageEvidence = $true
        break
      }
    }

    if (-not $current.IsEnabled -or $current.IsOffscreen) {
      continue
    }

    if (-not $current.IsKeyboardFocusable -and $controlType -notlike '*Document*') {
      continue
    }

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

    $rect = $current.BoundingRectangle
    $width = [double]$rect.Width
    $height = [double]$rect.Height
    $bottomDistance = [double]$rootRect.Bottom - [double]$rect.Bottom
    $score = 0

    foreach ($hint in $hints) {
      if ($evidence.Contains($hint.ToLowerInvariant())) {
        $score += 120
      }
    }

    if ($controlType.ToLowerInvariant().Contains('document')) {
      $score += 45
    }

    if ($controlType.ToLowerInvariant().Contains('edit')) {
      $score += 40
    }

    if ($current.IsKeyboardFocusable) {
      $score += 20
    }

    if ($width -ge 300) {
      $score += 20
    }

    if ($height -ge 30) {
      $score += 15
    }

    if ($height -le 260) {
      $score += 10
    }

    if ($bottomDistance -le 450) {
      $score += 35
    }
    elseif ($bottomDistance -le 800) {
      $score += 15
    }

    $valueAvailable = $false
    $textAvailable = $false

    try {
      $valueAvailable = [bool]$current.IsValuePatternAvailable
    }
    catch {
    }

    try {
      $textAvailable = [bool]$current.IsTextPatternAvailable
    }
    catch {
    }

    if ($valueAvailable) {
      $score += 25
    }

    if ($textAvailable) {
      $score += 25
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

if (-not $pageEvidence) {
  Write-Output "false"
  exit
}

$candidates = @($candidates | Sort-Object -Property score -Descending)

foreach ($candidate in $candidates) {
  try {
    $candidate.element.SetFocus()
    Start-Sleep -Milliseconds 120

    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement

    if ($null -eq $focused) {
      continue
    }

    $focusedCurrent = $focused.Current
    $focusedEvidence = (
      [string]$focusedCurrent.Name + ' ' +
      [string]$focusedCurrent.AutomationId + ' ' +
      [string]$focusedCurrent.HelpText + ' ' +
      [string]$focusedCurrent.ClassName + ' ' +
      [string]$focusedCurrent.FrameworkId + ' ' +
      [string]$focusedCurrent.ControlType.ProgrammaticName + ' ' +
      [string]$focusedCurrent.LocalizedControlType
    ).ToLowerInvariant()

    $blockedFocused = $false
    foreach ($term in $forbidden) {
      if ($focusedEvidence.Contains($term.ToLowerInvariant())) {
        $blockedFocused = $true
        break
      }
    }

    if ($blockedFocused) {
      continue
    }

    $sameRenderer = $false
    try {
      $sameRenderer = [int]$focusedCurrent.ProcessId -eq ${tab.processId}
    }
    catch {
    }

    if (-not $sameRenderer) {
      continue
    }

    $focusedRect = $focusedCurrent.BoundingRectangle

    if ($focusedRect.Width -lt 250 -and $focusedCurrent.ControlType.ProgrammaticName -notlike '*Document*') {
      continue
    }

    $focusedHint = $false
    foreach ($hint in $hints) {
      if ($focusedEvidence.Contains($hint.ToLowerInvariant())) {
        $focusedHint = $true
        break
      }
    }

    if (-not $focusedHint) {
      try {
        $parent = $focused
        for ($depth = 0; $depth -lt 6; $depth++) {
          $parent = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
          if ($null -eq $parent) {
            break
          }

          $parentEvidence = (
            [string]$parent.Current.Name + ' ' +
            [string]$parent.Current.HelpText + ' ' +
            [string]$parent.Current.AutomationId
          ).ToLowerInvariant()

          foreach ($hint in $hints) {
            if ($parentEvidence.Contains($hint.ToLowerInvariant())) {
              $focusedHint = $true
              break
            }
          }

          if ($focusedHint) {
            break
          }
        }
      }
      catch {
      }
    }

    if ($focusedHint -or $candidate.score -ge 140) {
      $shell = New-Object -ComObject WScript.Shell
      Start-Sleep -Milliseconds 100
      $shell.SendKeys("^v")
      Start-Sleep -Milliseconds 220

      $verified = $false

      try {
        $valuePattern = $focused.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        )

        if ($null -ne $valuePattern) {
          $value = [string]$valuePattern.Current.Value
          if (-not [string]::IsNullOrWhiteSpace($value)) {
            $verified = $value.Length -gt 0
          }
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
            $verified = -not [string]::IsNullOrWhiteSpace($text)
          }
        }
        catch {
        }
      }

      if (-not $verified) {
        continue
      }

      $shell.SendKeys("{ENTER}")
      Start-Sleep -Milliseconds 120
      Write-Output "true"
      exit
    }
  }
  catch {
  }
}

Write-Output "false"
`;

  const result = await runPowerShell(script, 12000);

  return result.success && result.stdout.trim().toLowerCase() === 'true';
}
