import { execFile } from 'node:child_process';

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
  timeout = 7000,
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

export async function sendMessageInBackground(
  handle: number,
  prompt: string,
): Promise<boolean> {
  if (
    !Number.isInteger(handle) ||
    handle <= 0 ||
    !prompt.trim()
  ) {
    return false;
  }

  const escapedPrompt =
    escapePowerShellString(
      prompt,
    );

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = [IntPtr]::new(${handle})
$prompt = '${escapedPrompt}'

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

$rankedEdits = @()

foreach ($element in $elements) {
  try {
    $current = $element.Current

    if (-not $current.IsEnabled) {
      continue
    }

    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    $className = [string]$current.ClassName
    $text = "$name $automationId $className".ToLowerInvariant()

    $score = 0

    foreach ($term in @(
      'message',
      'prompt',
      'ask',
      'question',
      'compose',
      'chat',
      'reply',
      'pergunta',
      'mensagem'
    )) {
      if ($text.Contains($term)) {
        $score += 10
      }
    }

    if ($current.IsOffscreen) {
      $score -= 5
    }

    $rankedEdits += [PSCustomObject]@{
      element = $element
      score = $score
    }
  }
  catch {
  }
}

$rankedEdits = @(
  $rankedEdits |
  Sort-Object -Property score -Descending
)

$set = $false

foreach ($entry in $rankedEdits) {
  try {
    $element = $entry.element

    try {
      $pattern =
        $element.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        )

      if ($null -ne $pattern) {
        if (-not $pattern.Current.IsReadOnly) {
          $pattern.SetValue($prompt)
          $set = $true
          break
        }
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
        $legacy.SetValue($prompt)
        $set = $true
        break
      }
    }
    catch {
    }
  }
  catch {
  }
}

if (-not $set) {
  Write-Output "false"
  exit
}

$buttonCondition =
  New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )

$buttons =
  $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $buttonCondition
  )

$rankedButtons = @()

foreach ($button in $buttons) {
  try {
    $current = $button.Current

    if (-not $current.IsEnabled) {
      continue
    }

    $name = [string]$current.Name
    $automationId = [string]$current.AutomationId
    $text = "$name $automationId".ToLowerInvariant()

    $score = 0

    foreach ($term in @(
      'send',
      'enviar',
      'submit',
      'send message',
      'send prompt',
      'enviar mensagem'
    )) {
      if ($text.Contains($term)) {
        $score += 20
      }
    }

    foreach ($term in @(
      'stop',
      'cancel',
      'parar',
      'cancelar'
    )) {
      if ($text.Contains($term)) {
        $score -= 30
      }
    }

    if ($score -gt 0) {
      $rankedButtons += [PSCustomObject]@{
        element = $button
        score = $score
      }
    }
  }
  catch {
  }
}

$rankedButtons = @(
  $rankedButtons |
  Sort-Object -Property score -Descending
)

foreach ($entry in $rankedButtons) {
  try {
    $pattern =
      $entry.element.GetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern
      )

    if ($null -ne $pattern) {
      $pattern.Invoke()
      Write-Output "true"
      exit
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
