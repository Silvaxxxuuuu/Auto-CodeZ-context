[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,
  [string]$Location = 'brazilsouth',
  [string]$ResourceGroup = 'rg-autocodez-account-test',
  [string]$NamePrefix = 'autocodezacct',
  [string]$PostgresAdmin = 'autocodezadmin',
  [ValidateRange(0, 1)]
  [int]$MinReplicas = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Az {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$Capture
  )
  if ($Capture) {
    $output = & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($Arguments -join ' ')" }
    return ($output -join [Environment]::NewLine).Trim()
  }
  & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($Arguments -join ' ')" }
}

function New-UrlSafeSecret {
  param([int]$Bytes = 48)
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
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

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI não foi encontrado. Instale a Azure CLI e execute az login antes de continuar.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$accountApiRoot = Join-Path $repoRoot 'services\account-api'
if (-not (Test-Path (Join-Path $accountApiRoot 'Dockerfile'))) {
  throw "Dockerfile do Account API não encontrado em $accountApiRoot"
}

Invoke-Az -Arguments @('account', 'set', '--subscription', $SubscriptionId)
Invoke-Az -Arguments @('extension', 'add', '--name', 'containerapp', '--upgrade', '--only-show-errors')

$suffix = Get-StableSuffix "$SubscriptionId|$NamePrefix"
$normalizedPrefix = ($NamePrefix.ToLowerInvariant() -replace '[^a-z0-9]', '')
if ($normalizedPrefix.Length -lt 3) {
  throw 'NamePrefix precisa conter pelo menos 3 caracteres alfanuméricos.'
}

$acrName = "$normalizedPrefix$suffix"
if ($acrName.Length -gt 50) { $acrName = $acrName.Substring(0, 50) }

$postgresName = ("$normalizedPrefix-$suffix-pg").ToLowerInvariant()
if ($postgresName.Length -gt 63) { $postgresName = $postgresName.Substring(0, 63).TrimEnd('-') }

$containerEnvName = ("$normalizedPrefix-$suffix-env").ToLowerInvariant()
$appName = ("$normalizedPrefix-$suffix-api").ToLowerInvariant()
$migrationJobName = ("$normalizedPrefix-$suffix-migrate").ToLowerInvariant()
$identityName = ("$normalizedPrefix-$suffix-pull").ToLowerInvariant()

foreach ($nameVariable in @('appName', 'migrationJobName')) {
  $value = Get-Variable -Name $nameVariable -ValueOnly
  if ($value.Length -gt 31) {
    Set-Variable -Name $nameVariable -Value $value.Substring(0, 31).TrimEnd('-')
  }
}

$gitSha = (& git -C $repoRoot rev-parse --short=12 HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $gitSha) {
  $gitSha = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm')
}
$imageTag = $gitSha.Trim()
$imageName = "account-api:$imageTag"

Write-Host ''
Write-Host '== Auto CodeZ Account API Azure bootstrap =='
Write-Host "Resource group: $ResourceGroup"
Write-Host "Location:       $Location"
Write-Host "ACR:            $acrName"
Write-Host "PostgreSQL:     $postgresName"
Write-Host "Container App:  $appName"
Write-Host ''

Invoke-Az -Arguments @(
  'group', 'create',
  '--name', $ResourceGroup,
  '--location', $Location,
  '--tags', 'project=AutoCodeZ', 'purpose=account-v1-test',
  '--output', 'none'
)

Invoke-Az -Arguments @(
  'acr', 'create',
  '--resource-group', $ResourceGroup,
  '--name', $acrName,
  '--location', $Location,
  '--sku', 'Basic',
  '--admin-enabled', 'false',
  '--output', 'none'
)

Push-Location $accountApiRoot
try {
  Invoke-Az -Arguments @(
    'acr', 'build',
    '--registry', $acrName,
    '--image', $imageName,
    '--file', 'Dockerfile',
    '.',
    '--output', 'none'
  )
} finally {
  Pop-Location
}

$identityJson = Invoke-Az -Arguments @(
  'identity', 'create',
  '--resource-group', $ResourceGroup,
  '--name', $identityName,
  '--location', $Location,
  '--output', 'json'
) -Capture | ConvertFrom-Json

$identityId = [string]$identityJson.id
$identityPrincipalId = [string]$identityJson.principalId
$acrId = Invoke-Az -Arguments @(
  'acr', 'show',
  '--resource-group', $ResourceGroup,
  '--name', $acrName,
  '--query', 'id',
  '--output', 'tsv'
) -Capture

Invoke-Az -Arguments @(
  'role', 'assignment', 'create',
  '--assignee-object-id', $identityPrincipalId,
  '--assignee-principal-type', 'ServicePrincipal',
  '--role', 'AcrPull',
  '--scope', $acrId,
  '--output', 'none'
)

Invoke-Az -Arguments @(
  'containerapp', 'env', 'create',
  '--name', $containerEnvName,
  '--resource-group', $ResourceGroup,
  '--location', $Location,
  '--output', 'none'
)

$postgresPassword = (New-UrlSafeSecret 30) + 'aA1!'
$betterAuthSecret = New-UrlSafeSecret 48
$accessTokenSecret = New-UrlSafeSecret 48

Invoke-Az -Arguments @(
  'postgres', 'flexible-server', 'create',
  '--resource-group', $ResourceGroup,
  '--name', $postgresName,
  '--location', $Location,
  '--admin-user', $PostgresAdmin,
  '--admin-password', $postgresPassword,
  '--database-name', 'autocodez',
  '--version', '16',
  '--tier', 'Burstable',
  '--sku-name', 'Standard_B1ms',
  '--storage-size', '32',
  '--backup-retention', '7',
  '--public-access', '0.0.0.0',
  '--yes',
  '--output', 'none'
)

Invoke-Az -Arguments @(
  'containerapp', 'create',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--environment', $containerEnvName,
  '--image', 'mcr.microsoft.com/k8se/quickstart:latest',
  '--target-port', '80',
  '--ingress', 'external',
  '--user-assigned', $identityId,
  '--cpu', '0.25',
  '--memory', '0.5Gi',
  '--min-replicas', [string]$MinReplicas,
  '--max-replicas', '2',
  '--output', 'none'
)

$fqdn = Invoke-Az -Arguments @(
  'containerapp', 'show',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--query', 'properties.configuration.ingress.fqdn',
  '--output', 'tsv'
) -Capture
if (-not $fqdn) { throw 'A Azure não retornou o FQDN do Container App.' }

$publicUrl = "https://$fqdn"
$encodedDbPassword = [Uri]::EscapeDataString($postgresPassword)
$databaseUrl = "postgresql://$PostgresAdmin:$encodedDbPassword@$postgresName.postgres.database.azure.com:5432/autocodez?sslmode=require"
$registryServer = "$acrName.azurecr.io"
$fullImage = "$registryServer/$imageName"

Invoke-Az -Arguments @(
  'containerapp', 'secret', 'set',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--secrets',
  "database-url=$databaseUrl",
  "better-auth-secret=$betterAuthSecret",
  "access-token-secret=$accessTokenSecret",
  '--output', 'none'
)

Invoke-Az -Arguments @(
  'containerapp', 'registry', 'set',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--server', $registryServer,
  '--identity', $identityId,
  '--output', 'none'
)

Invoke-Az -Arguments @(
  'containerapp', 'job', 'create',
  '--name', $migrationJobName,
  '--resource-group', $ResourceGroup,
  '--environment', $containerEnvName,
  '--trigger-type', 'Manual',
  '--replica-timeout', '900',
  '--replica-retry-limit', '0',
  '--replica-completion-count', '1',
  '--parallelism', '1',
  '--image', $fullImage,
  '--cpu', '0.25',
  '--memory', '0.5Gi',
  '--mi-user-assigned', $identityId,
  '--registry-server', $registryServer,
  '--registry-identity', $identityId,
  '--command', 'npm',
  '--args', 'run', 'migrate',
  '--secrets',
  "database-url=$databaseUrl",
  "better-auth-secret=$betterAuthSecret",
  "access-token-secret=$accessTokenSecret",
  '--env-vars',
  "ACCOUNT_PUBLIC_URL=$publicUrl",
  'PORT=8080',
  'DATABASE_URL=secretref:database-url',
  'BETTER_AUTH_SECRET=secretref:better-auth-secret',
  'ACCOUNT_ACCESS_TOKEN_SECRET=secretref:access-token-secret',
  "PASSKEY_RP_ID=$fqdn",
  'PASSKEY_RP_NAME=Auto CodeZ',
  '--output', 'none'
)

$executionJson = Invoke-Az -Arguments @(
  'containerapp', 'job', 'start',
  '--name', $migrationJobName,
  '--resource-group', $ResourceGroup,
  '--output', 'json'
) -Capture | ConvertFrom-Json

$executionName = [string]$executionJson.name
if (-not $executionName) { throw 'A Azure não retornou o nome da execução da migration.' }

$deadline = (Get-Date).AddMinutes(15)
$migrationStatus = ''
do {
  Start-Sleep -Seconds 5
  $migrationStatus = Invoke-Az -Arguments @(
    'containerapp', 'job', 'execution', 'show',
    '--name', $migrationJobName,
    '--resource-group', $ResourceGroup,
    '--job-execution-name', $executionName,
    '--query', 'properties.status',
    '--output', 'tsv'
  ) -Capture
  Write-Host "Migration: $migrationStatus"
  if ($migrationStatus -eq 'Succeeded') { break }
  if ($migrationStatus -eq 'Failed') {
    throw "Migration job falhou. Consulte os logs do job $migrationJobName."
  }
} while ((Get-Date) -lt $deadline)

if ($migrationStatus -ne 'Succeeded') {
  throw 'Migration job não terminou dentro de 15 minutos.'
}

Invoke-Az -Arguments @(
  'containerapp', 'update',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--image', $fullImage,
  '--cpu', '0.25',
  '--memory', '0.5Gi',
  '--min-replicas', [string]$MinReplicas,
  '--max-replicas', '2',
  '--replace-env-vars',
  "ACCOUNT_PUBLIC_URL=$publicUrl",
  'PORT=8080',
  'DATABASE_URL=secretref:database-url',
  'BETTER_AUTH_SECRET=secretref:better-auth-secret',
  'ACCOUNT_ACCESS_TOKEN_SECRET=secretref:access-token-secret',
  "PASSKEY_RP_ID=$fqdn",
  'PASSKEY_RP_NAME=Auto CodeZ',
  '--output', 'none'
)

Invoke-Az -Arguments @(
  'containerapp', 'ingress', 'update',
  '--name', $appName,
  '--resource-group', $ResourceGroup,
  '--target-port', '8080',
  '--transport', 'auto',
  '--output', 'none'
)

$healthUrl = "$publicUrl/healthz"
$configurationUrl = "$publicUrl/v1/auth/configuration"

Write-Host ''
Write-Host 'Bootstrap concluído.'
Write-Host "Account API: $publicUrl"
Write-Host "Health:      $healthUrl"
Write-Host ''
Write-Host 'OAuth callback URLs:'
Write-Host "GitHub:    $publicUrl/api/auth/callback/github"
Write-Host "Google:    $publicUrl/api/auth/callback/google"
Write-Host "Microsoft: $publicUrl/api/auth/callback/microsoft"
Write-Host ''
Write-Host 'Próximo passo: configure os providers com configure-providers.ps1.'
Write-Host ''
Write-Host 'Desktop local:'
Write-Host ('  $env:AUTO_CODEZ_ACCOUNT_API_BASE_URL="{0}"' -f $publicUrl)
Write-Host ''

for ($attempt = 1; $attempt -le 24; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 10
    if ($health.ok -eq $true) {
      Write-Host 'Health check: OK'
      break
    }
  } catch {
    if ($attempt -eq 24) {
      Write-Warning 'O deploy terminou, mas /healthz ainda não respondeu OK. Verifique logs do Container App.'
      break
    }
    Start-Sleep -Seconds 5
  }
}

try {
  $configuration = Invoke-RestMethod -Uri $configurationUrl -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10
  Write-Host ('Métodos disponíveis agora: ' + (($configuration.methods | ForEach-Object { [string]$_ }) -join ', '))
} catch {
  Write-Warning 'Não foi possível consultar /v1/auth/configuration agora.'
}
