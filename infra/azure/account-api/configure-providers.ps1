[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$ResourceGroup = 'rg-autocodez-account-test',
  [string]$NamePrefix = 'autocodezacct',
  [string]$GitHubClientId,
  [string]$GoogleClientId,
  [string]$MicrosoftClientId,
  [string]$MicrosoftTenantId = 'common',
  [string]$AzureEmailSender
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Az {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$Capture
  )
  $operation = if ($Arguments.Count -ge 2) {
    "az $($Arguments[0]) $($Arguments[1])"
  } elseif ($Arguments.Count -eq 1) {
    "az $($Arguments[0])"
  } else {
    'az'
  }

  if ($Capture) {
    $output = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Azure CLI failed during $operation (exit code $LASTEXITCODE). Arguments were intentionally omitted."
    }
    return ($output -join [Environment]::NewLine).Trim()
  }

  & az @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI failed during $operation (exit code $LASTEXITCODE). Arguments were intentionally omitted."
  }
}

function Get-StableSuffix {
  param([string]$Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return ([Convert]::ToHexString($hash).Substring(0, 8)).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-SecretValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$EnvironmentName,
    [Parameter(Mandatory = $true)]
    [string]$Prompt
  )

  $fromEnvironment = [Environment]::GetEnvironmentVariable($EnvironmentName)
  if ($fromEnvironment) {
    return $fromEnvironment
  }

  $secure = Read-Host $Prompt -AsSecureString
  if (-not $secure -or $secure.Length -eq 0) {
    throw "$Prompt não pode ficar vazio."
  }

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI não foi encontrado.' }

if ($SubscriptionId) {
  Invoke-Az -Arguments @('account', 'set', '--subscription', $SubscriptionId)
} else {
  $SubscriptionId = Invoke-Az -Arguments @(
    'account', 'show',
    '--query', 'id',
    '--output', 'tsv'
  ) -Capture
  if (-not $SubscriptionId) {
    throw 'Nenhuma assinatura Azure ativa. Execute az login primeiro.'
  }
}

$suffix = Get-StableSuffix "$SubscriptionId|$NamePrefix"
$normalizedPrefix = ($NamePrefix.ToLowerInvariant() -replace '[^a-z0-9]', '')
$appName = ("$normalizedPrefix-$suffix-api").ToLowerInvariant()
if ($appName.Length -gt 31) { $appName = $appName.Substring(0, 31).TrimEnd('-') }

$fqdn = Invoke-Az -Arguments @(
  'containerapp', 'show',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--query', 'properties.configuration.ingress.fqdn',
  '--output', 'tsv'
) -Capture
if (-not $fqdn) { throw 'Container App não encontrado ou sem FQDN.' }

$publicUrl = "https://$fqdn"

$GitHubClientSecret = if ($GitHubClientId) {
  Read-SecretValue -EnvironmentName 'AUTO_CODEZ_GITHUB_CLIENT_SECRET' -Prompt 'GitHub Client Secret'
} else { $null }

$GoogleClientSecret = if ($GoogleClientId) {
  Read-SecretValue -EnvironmentName 'AUTO_CODEZ_GOOGLE_CLIENT_SECRET' -Prompt 'Google Client Secret'
} else { $null }

$MicrosoftClientSecret = if ($MicrosoftClientId) {
  Read-SecretValue -EnvironmentName 'AUTO_CODEZ_MICROSOFT_CLIENT_SECRET' -Prompt 'Microsoft Client Secret'
} else { $null }

$AzureEmailConnectionString = if ($AzureEmailSender) {
  Read-SecretValue -EnvironmentName 'AUTO_CODEZ_AZURE_EMAIL_CONNECTION_STRING' -Prompt 'Azure Communication Services Email connection string'
} else { $null }

$secretArgs = @()
$envArgs = @(
  "ACCOUNT_PUBLIC_URL=$publicUrl",
  "PASSKEY_RP_ID=$fqdn",
  'PASSKEY_RP_NAME=Auto CodeZ'
)

if ($GitHubClientId) {
  $secretArgs += "github-client-secret=$GitHubClientSecret"
  $envArgs += "GITHUB_CLIENT_ID=$GitHubClientId"
  $envArgs += 'GITHUB_CLIENT_SECRET=secretref:github-client-secret'
}

if ($GoogleClientId) {
  $secretArgs += "google-client-secret=$GoogleClientSecret"
  $envArgs += "GOOGLE_CLIENT_ID=$GoogleClientId"
  $envArgs += 'GOOGLE_CLIENT_SECRET=secretref:google-client-secret'
}

if ($MicrosoftClientId) {
  $secretArgs += "microsoft-client-secret=$MicrosoftClientSecret"
  $envArgs += "MICROSOFT_CLIENT_ID=$MicrosoftClientId"
  $envArgs += 'MICROSOFT_CLIENT_SECRET=secretref:microsoft-client-secret'
  $envArgs += "MICROSOFT_TENANT_ID=$MicrosoftTenantId"
}

if ($AzureEmailConnectionString) {
  $secretArgs += "azure-email-connection=$AzureEmailConnectionString"
  $envArgs += 'AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING=secretref:azure-email-connection'
  $envArgs += "AZURE_EMAIL_SENDER=$AzureEmailSender"
}

if ($secretArgs.Count -gt 0) {
  Invoke-Az -Arguments (@(
    'containerapp', 'secret', 'set',
    '--name', $appName,
    '--resource-group', $ResourceGroup,
    '--secrets'
  ) + $secretArgs + @('--output', 'none'))
}

Invoke-Az -Arguments (@(
  'containerapp', 'update',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--set-env-vars'
) + $envArgs + @('--output', 'none'))

Write-Host ''
Write-Host "Account API: $publicUrl"
Write-Host ''
Write-Host 'Cadastre estas callback URLs nos providers:'
Write-Host "GitHub:    $publicUrl/api/auth/callback/github"
Write-Host "Google:    $publicUrl/api/auth/callback/google"
Write-Host "Microsoft: $publicUrl/api/auth/callback/microsoft"
Write-Host ''

Start-Sleep -Seconds 5
try {
  $configuration = Invoke-RestMethod -Uri "$publicUrl/v1/auth/configuration" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 15
  Write-Host ('Métodos anunciados pelo backend: ' + (($configuration.methods | ForEach-Object { [string]$_ }) -join ', '))
} catch {
  Write-Warning 'Configuração atualizada, mas o endpoint ainda não respondeu. Aguarde a nova revision ficar pronta.'
}
