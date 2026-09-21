[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$Repository = 'Silvaxxxuuuu/Auto-CodeZ-context',
  [string]$Branch = 'feature/ui-hierarchy-polish',
  [string]$ApplicationName = 'auto-codez-account-deploy',
  [string]$ResourceGroup = 'rg-autocodez-account-test',
  [string]$Location = 'brazilsouth'
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
    if ($LASTEXITCODE -ne 0) {
      throw "Azure CLI falhou em az $($Arguments[0])."
    }
    return ($output -join [Environment]::NewLine).Trim()
  }

  & az @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI falhou em az $($Arguments[0])."
  }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI não foi encontrado.'
}

if ($SubscriptionId) {
  Invoke-Az -Arguments @('account', 'set', '--subscription', $SubscriptionId)
} else {
  $SubscriptionId = Invoke-Az -Arguments @(
    'account', 'show',
    '--query', 'id',
    '--output', 'tsv'
  ) -Capture
}

if (-not $SubscriptionId) {
  throw 'Nenhuma assinatura Azure ativa. Execute az login.'
}

$tenantId = Invoke-Az -Arguments @(
  'account', 'show',
  '--query', 'tenantId',
  '--output', 'tsv'
) -Capture

$appId = Invoke-Az -Arguments @(
  'ad', 'app', 'list',
  '--display-name', $ApplicationName,
  '--query', '[0].appId',
  '--output', 'tsv'
) -Capture

if (-not $appId) {
  $appId = Invoke-Az -Arguments @(
    'ad', 'app', 'create',
    '--display-name', $ApplicationName,
    '--query', 'appId',
    '--output', 'tsv'
  ) -Capture
}

$spObjectId = Invoke-Az -Arguments @(
  'ad', 'sp', 'list',
  '--filter', "appId eq '$appId'",
  '--query', '[0].id',
  '--output', 'tsv'
) -Capture

if (-not $spObjectId) {
  $spObjectId = Invoke-Az -Arguments @(
    'ad', 'sp', 'create',
    '--id', $appId,
    '--query', 'id',
    '--output', 'tsv'
  ) -Capture
}

$federatedName = 'feature-ui-hierarchy-polish'
$existingFederation = Invoke-Az -Arguments @(
  'ad', 'app', 'federated-credential', 'list',
  '--id', $appId,
  '--query', "[?name=='$federatedName'].id | [0]",
  '--output', 'tsv'
) -Capture

if (-not $existingFederation) {
  $parameters = @{
    name = $federatedName
    issuer = 'https://token.actions.githubusercontent.com'
    subject = ('repo:{0}:ref:refs/heads/{1}' -f $Repository, $Branch)
    description = 'Auto CodeZ Account API deploy from feature branch'
    audiences = @('api://AzureADTokenExchange')
  }

  $temp = Join-Path ([IO.Path]::GetTempPath()) ('autocodez-oidc-' + [Guid]::NewGuid().ToString('N') + '.json')
  try {
    $parameters | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temp -Encoding utf8
    Invoke-Az -Arguments @(
      'ad', 'app', 'federated-credential', 'create',
      '--id', $appId,
      '--parameters', "@$temp",
      '--output', 'none'
    )
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Preparando resource providers com a identidade local autenticada...'
foreach ($providerNamespace in @(
  'Microsoft.App',
  'Microsoft.ContainerRegistry',
  'Microsoft.DBforPostgreSQL',
  'Microsoft.ManagedIdentity',
  'Microsoft.OperationalInsights'
)) {
  Invoke-Az -Arguments @(
    'provider', 'register',
    '--namespace', $providerNamespace,
    '--wait',
    '--output', 'none'
  )
}

Invoke-Az -Arguments @(
  'group', 'create',
  '--name', $ResourceGroup,
  '--location', $Location,
  '--tags', 'project=AutoCodeZ', 'purpose=account-v1-test',
  '--output', 'none'
)

$scope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"
foreach ($role in @('Contributor', 'User Access Administrator')) {
  $existingRole = Invoke-Az -Arguments @(
    'role', 'assignment', 'list',
    '--assignee-object-id', $spObjectId,
    '--scope', $scope,
    '--role', $role,
    '--query', '[0].id',
    '--output', 'tsv'
  ) -Capture

  if (-not $existingRole) {
    Invoke-Az -Arguments @(
      'role', 'assignment', 'create',
      '--assignee-object-id', $spObjectId,
      '--assignee-principal-type', 'ServicePrincipal',
      '--role', $role,
      '--scope', $scope,
      '--output', 'none'
    )
  }
}

Write-Host ''
Write-Host 'OIDC configurado.'
Write-Host "Repository:      $Repository"
Write-Host "Branch:          $Branch"
Write-Host "AZURE_CLIENT_ID: $appId"
Write-Host "AZURE_TENANT_ID: $tenantId"
Write-Host "AZURE_SUBSCRIPTION_ID: $SubscriptionId"
Write-Host "Resource group scope: $ResourceGroup"
Write-Host ''

if (Get-Command gh -ErrorAction SilentlyContinue) {
  & gh auth status *> $null
  if ($LASTEXITCODE -eq 0) {
    & gh variable set AZURE_CLIENT_ID --repo $Repository --body $appId
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao gravar AZURE_CLIENT_ID no GitHub.' }

    & gh variable set AZURE_TENANT_ID --repo $Repository --body $tenantId
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao gravar AZURE_TENANT_ID no GitHub.' }

    & gh variable set AZURE_SUBSCRIPTION_ID --repo $Repository --body $SubscriptionId
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao gravar AZURE_SUBSCRIPTION_ID no GitHub.' }

    Write-Host 'Repository variables gravadas no GitHub.'
    exit 0
  }
}

Write-Host 'GitHub CLI não está autenticado. Grave os três IDs acima em:'
Write-Host ('GitHub > {0} > Settings > Secrets and variables > Actions > Variables' -f $Repository)
