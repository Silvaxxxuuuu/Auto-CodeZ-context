[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$ResourceGroup = 'rg-autocodez-account-test',
  [switch]$ConfirmDelete
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ConfirmDelete) {
  throw 'Nada foi apagado. Execute novamente com -ConfirmDelete para remover o resource group inteiro.'
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI não foi encontrado.' }

if ($SubscriptionId) {
  & az account set --subscription $SubscriptionId
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao selecionar a assinatura.' }
} else {
  $SubscriptionId = (& az account show --query id --output tsv).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $SubscriptionId) {
    throw 'Nenhuma assinatura Azure ativa. Execute az login primeiro.'
  }
}

& az group delete --name $ResourceGroup --yes --no-wait
if ($LASTEXITCODE -ne 0) { throw 'Falha ao solicitar remoção do resource group.' }

Write-Host "Remoção solicitada para $ResourceGroup."
