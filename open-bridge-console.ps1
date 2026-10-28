param(
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeRoot = Join-Path $root 'bridge'
$configPath = Join-Path $bridgeRoot 'config.json'
$tokenPath = Join-Path $bridgeRoot 'state\console-token'

$configText = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
$config = $configText | ConvertFrom-Json
$port = if ($config.consolePort) { [int]$config.consolePort } else { 3100 }
$token = ([string]$config.consoleToken).Trim()
if (-not $token -and (Test-Path -LiteralPath $tokenPath)) {
  $token = ([IO.File]::ReadAllText($tokenPath, [Text.Encoding]::UTF8)).Trim()
}
if (-not $token) {
  throw '未找到 Bridge 控制台访问令牌。请先启动 Bridge，让它生成 state\console-token。'
}

$url = "http://127.0.0.1:$port/?token=$([uri]::EscapeDataString($token))"
Write-Host 'Bridge 管理页面（包含访问令牌，请勿分享）：' -ForegroundColor Yellow
Write-Host $url

if ($NoOpen) { return }

$edgeCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw '未找到 Microsoft Edge。请复制上方地址到浏览器访问。' }

$profile = Join-Path $root 'browser-profile\bridge-console'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
Start-Process -FilePath $edge -ArgumentList @('--inprivate', '--new-window', "--user-data-dir=$profile", $url)
