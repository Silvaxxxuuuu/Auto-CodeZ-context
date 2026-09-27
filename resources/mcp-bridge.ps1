param(
  [Parameter(Mandatory = $true)][string]$BrokerAddress,
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$ClientId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-BridgeError([string]$Message) {
  [Console]::Error.WriteLine("Auto CodeZ MCP bridge: $Message")
}

function Read-Binding {
  $prefix = '\\.\pipe\'
  if (-not $BrokerAddress.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Endereço IPC MCP inválido.'
  }
  $pipeName = $BrokerAddress.Substring($prefix.Length)
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::In)
  try {
    $pipe.Connect(1500)
    $reader = [System.IO.StreamReader]::new($pipe, [System.Text.UTF8Encoding]::new($false), $false, 4096, $true)
    try {
      $line = $reader.ReadLine()
    } finally {
      $reader.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($line) -or $line -eq 'null') { return $null }
    $binding = $line | ConvertFrom-Json
    if (-not $binding.endpoint -or -not $binding.bearerToken) { return $null }
    return $binding
  } finally {
    $pipe.Dispose()
  }
}

function Resolve-Binding {
  try { $binding = Read-Binding } catch { $binding = $null }
  if ($binding) { return $binding }

  Start-Process -FilePath $AppPath -WindowStyle Hidden | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 150
    try { $binding = Read-Binding } catch { $binding = $null }
    if ($binding) { return $binding }
  }
  throw 'Auto CodeZ não iniciou o MCP local dentro do tempo esperado.'
}

function Invoke-Mcp([object]$Binding, [string]$Payload) {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  try {
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, [string]$Binding.endpoint)
    try {
      $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Binding.bearerToken)
      $request.Headers.Add('x-auto-codez-mcp-client', $ClientId)
      $request.Content = [System.Net.Http.StringContent]::new($Payload, [System.Text.UTF8Encoding]::new($false), 'application/json')
      $response = $client.SendAsync($request).GetAwaiter().GetResult()
      try {
        if ([int]$response.StatusCode -eq 202) { return $null }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
          throw "MCP Gateway retornou HTTP $([int]$response.StatusCode)."
        }
        return $body
      } finally {
        $response.Dispose()
      }
    } finally {
      $request.Dispose()
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

try {
  $binding = Resolve-Binding
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $null = $line | ConvertFrom-Json
      $response = Invoke-Mcp $binding $line
    } catch {
      try {
        $binding = Resolve-Binding
        $response = Invoke-Mcp $binding $line
      } catch {
        $message = $_.Exception.Message.Replace('"', '\"')
        $response = "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32000,\"message\":\"$message\"}}"
      }
    }
    if ($null -ne $response) {
      [Console]::Out.WriteLine($response)
      [Console]::Out.Flush()
    }
  }
  exit 0
} catch {
  Write-BridgeError $_.Exception.Message
  exit 1
}
