$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Join-Path $PWD 'artifacts\vision-real'
$runtime = Join-Path $root 'runtime'
$downloads = Join-Path $root 'downloads'
$fixtures = Join-Path $root 'fixtures'
New-Item -ItemType Directory -Force -Path $runtime,$downloads,$fixtures | Out-Null

function Download-Verified {
  param([string]$Url,[string]$Destination,[string]$Sha256,[Int64]$Bytes)
  if (-not (Test-Path $Destination)) { Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing }
  $item = Get-Item $Destination
  if ($Bytes -gt 0 -and $item.Length -ne $Bytes) { throw "Unexpected size for ${Destination}: $($item.Length), expected $Bytes" }
  $actual = (Get-FileHash -Path $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) { throw "SHA-256 mismatch for ${Destination}: $actual" }
}

$engineZip = Join-Path $downloads 'llama-b10837-bin-win-cpu-x64.zip'
Download-Verified -Url 'https://github.com/ggml-org/llama.cpp/releases/download/b10837/llama-b10837-bin-win-cpu-x64.zip' -Destination $engineZip -Sha256 'b1b304054b13676d03876cce0e29d6c62b1de2a66456d1cd591afbdf15348088' -Bytes 18417206

if (-not (Test-Path (Join-Path $runtime 'llama-server.exe'))) { Expand-Archive -Path $engineZip -DestinationPath $runtime -Force }
$serverExe = Join-Path $runtime 'llama-server.exe'
if (-not (Test-Path $serverExe)) { throw 'llama-server.exe missing after verified extraction.' }

$modelPath = Join-Path $downloads 'SmolVLM-256M-Instruct-Q8_0.gguf'
$projectorPath = Join-Path $downloads 'mmproj-SmolVLM-256M-Instruct-Q8_0.gguf'
Download-Verified -Url 'https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/SmolVLM-256M-Instruct-Q8_0.gguf?download=true' -Destination $modelPath -Sha256 '2a31195d3769c0b0fd0a4906201666108834848db768af11de1d2cef7cd35e65' -Bytes 175054528
Download-Verified -Url 'https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-256M-Instruct-Q8_0.gguf?download=true' -Destination $projectorPath -Sha256 '7e943f7c53f0382a6fc41b6ee0c2def63ba4fded9ab8ed039cc9e2ab905e0edd' -Bytes 103769856

Add-Type -AssemblyName System.Drawing

function New-TestImage {
  param([string]$Path,[string]$Title,[string[]]$Lines,[string]$AccentText)
  $bitmap = New-Object System.Drawing.Bitmap 1280,800
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::FromArgb(12,16,22))
  $panelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(23,30,40))
  $panel2Brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(31,40,53))
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(235,240,247))
  $mutedBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(164,176,191))
  $accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(80,145,232))
  $titleFont = [System.Drawing.Font]::new('Segoe UI',[single]30,[System.Drawing.FontStyle]::Bold)
  $lineFont = [System.Drawing.Font]::new('Consolas',[single]21,[System.Drawing.FontStyle]::Regular)
  $smallFont = [System.Drawing.Font]::new('Segoe UI',[single]17,[System.Drawing.FontStyle]::Regular)
  $accentFont = [System.Drawing.Font]::new('Segoe UI',[single]19,[System.Drawing.FontStyle]::Bold)
  $graphics.FillRectangle($panelBrush,45,45,1190,710)
  $graphics.FillRectangle($panel2Brush,75,100,1130,86)
  $graphics.DrawString($Title,$titleFont,$textBrush,100,117)
  $graphics.FillRectangle($accentBrush,910,119,245,48)
  $graphics.DrawString($AccentText,$accentFont,[System.Drawing.Brushes]::White,930,127)
  $y = 225
  foreach ($line in $Lines) { $graphics.DrawString($line,$lineFont,$textBrush,105,$y); $y += 54 }
  $graphics.DrawString('Auto CodeZ vision integration fixture - local only',$smallFont,$mutedBrush,100,700)
  $bitmap.Save($Path,[System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  $panelBrush.Dispose(); $panel2Brush.Dispose(); $textBrush.Dispose(); $mutedBrush.Dispose(); $accentBrush.Dispose()
  $titleFont.Dispose(); $lineFont.Dispose(); $smallFont.Dispose(); $accentFont.Dispose()
}

$fixture1 = Join-Path $fixtures 'dashboard.png'
$fixture2 = Join-Path $fixtures 'terminal.png'
$fixture3 = Join-Path $fixtures 'devices.png'
New-TestImage $fixture1 'AUTO CODEZ BUILD 358' @('STATUS          READY','PROVIDER        LOCAL VISION','LATENCY         42 ms','FILES INDEXED   17','ERRORS          0','COMMAND         npm run test:visual','BRANCH          feature/ui-hierarchy-polish') 'RUN TESTS'
New-TestImage $fixture2 'TERMINAL - PROVIDER RECOVERY' @('ERROR           E429 RATE LIMIT','Retry-After     35 seconds','MODEL           GPT-5.6 Luna','ATTEMPT         3 / 8','TESTS           21 / 21 PASS','EXIT CODE       0','MESSAGE         retry scheduled automatically') 'RECOVERING'
New-TestImage $fixture3 'DEVICE REGISTRY' @('DEVICE          PC Principal','SYSTEM          Windows x64','SESSION         ACTIVE','LAST SYNC       14:32','TRUST           PROTECTED KEY','REMOTE DEVICES  3','REVOKED         1') 'CONNECTED'


function Invoke-WindowsOcr {
  param([string]$ImagePath,[string]$Name,[string[]]$Expected)
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1)
  function Await-WinRt([object]$Operation,[Type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
    $task.Wait()
    return $task.Result
  }
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($ImagePath))) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'Windows OCR engine unavailable.' }
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = [string]$result.Text
  $text | Out-File -FilePath (Join-Path $root "$Name-ocr.txt") -Encoding utf8
  $hits = 0
  foreach ($needle in $Expected) { if ($text -match [Regex]::Escape($needle)) { $hits++ } }
  if ($hits -lt 4) { throw "OCR result for $Name matched only $hits expected facts. Output: $text" }
  Write-Host "[OCR $Name] matched $hits/$($Expected.Count) facts"
}

Invoke-WindowsOcr $fixture1 'dashboard' @('358','42','17','READY','test:visual')
Invoke-WindowsOcr $fixture2 'terminal' @('429','35','21','PASS','3')
Invoke-WindowsOcr $fixture3 'devices' @('PC Principal','Windows','14:32','3','ACTIVE')

$port = 18088
$stdout = Join-Path $root 'llama.stdout.log'
$stderr = Join-Path $root 'llama.stderr.log'
$args = @('--model',$modelPath,'--mmproj',$projectorPath,'--alias','smolvlm-256m-instruct-q8','--host','127.0.0.1','--port',"$port",'--ctx-size','4096','--jinja')
$process = Start-Process -FilePath $serverExe -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

try {
  $deadline = (Get-Date).AddSeconds(90)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
      if (Test-Path $stderr) { Get-Content $stderr }
      throw "llama-server exited during startup with code $($process.ExitCode)."
    }
    try {
      $health = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
      if ($health.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'llama-server did not become ready.' }

  function Invoke-Vision {
    param([string]$ImagePath,[string]$Name,[string[]]$Expected)
    $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($ImagePath))
    $body = @{
      model = 'smolvlm-256m-instruct-q8'
      temperature = 0
      max_tokens = 1200
      messages = @(@{
        role = 'user'
        content = @(
          @{ type = 'text'; text = 'Read this software screenshot carefully. Return a dense factual description. Copy every visible word, number, status, command and error you can read. Do not invent anything.' },
          @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$base64" } }
        )
      })
    } | ConvertTo-Json -Depth 10 -Compress
    $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/v1/chat/completions" -ContentType 'application/json' -Body $body -TimeoutSec 90
    $text = [string]$response.choices[0].message.content
    if ([string]::IsNullOrWhiteSpace($text)) { throw "Empty vision result for $Name" }
    $text | Out-File -FilePath (Join-Path $root "$Name.txt") -Encoding utf8
    $hits = 0
    foreach ($needle in $Expected) { if ($text -match [Regex]::Escape($needle)) { $hits++ } }
    if ($hits -lt 1) { throw "Vision result for $Name matched only $hits expected facts. Output: $text" }
    Write-Host "[$Name] matched $hits/$($Expected.Count) facts"
    Write-Host $text
  }

  Invoke-Vision $fixture1 'dashboard-result' @('358','42','17','READY','test:visual')
  Invoke-Vision $fixture2 'terminal-result' @('429','35','21','PASS','3')
  Invoke-Vision $fixture3 'devices-result' @('PC Principal','Windows','14:32','3','ACTIVE')
}
finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
