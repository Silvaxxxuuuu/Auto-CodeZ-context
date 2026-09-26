[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$origin = ([Uri]$BaseUrl).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
if (-not $origin.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'BaseUrl precisa usar HTTPS.'
}

$health = Invoke-RestMethod -Uri "$origin/healthz" -Method Get -TimeoutSec 15
if ($health.ok -ne $true) { throw '/healthz não retornou ok=true.' }

$configuration = Invoke-RestMethod -Uri "$origin/v1/auth/configuration" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 15
$methods = @($configuration.methods | ForEach-Object { [string]$_ })
if (-not ($methods -contains 'passkey')) { throw 'Backend não anunciou Passkey.' }

Write-Host 'Health: OK'
Write-Host ('Methods: ' + ($methods -join ', '))
Write-Host "GitHub callback:    $origin/api/auth/callback/github"
Write-Host "Google callback:    $origin/api/auth/callback/google"
Write-Host "Microsoft callback: $origin/api/auth/callback/microsoft"
