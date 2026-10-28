@echo off
rem ============================================================================
rem  restart.bat — restart.sh 的 Windows 等价物
rem    停旧守护与旧桥接 → 清理过期锁 → 后台重启守护（崩溃 5 秒后自动拉起）
rem
rem  用法：
rem    双击运行，或在 cmd 里执行 restart.bat
rem    restart.bat --minimized   以最小化窗口启动守护（不进前台，适合开机自启/脚本调用）
rem    restart.bat --foreground  在当前窗口前台重启（日志直接刷在本窗口，最接近 npm.cmd start）
rem    Windows 10/11 + Node.js 22.13+
rem
rem  停止桥接：关闭「qq-bridge-daemon」守护窗口即可
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0" || (echo [错误] 无法进入脚本目录：%~dp0 & pause & exit /b 1)
set "QQB_SELF=%~f0"
set "QQB_BRIDGE_ROOT=%~dp0"
rem 守护窗口默认可见（和 npm.cmd start 一样能实时看日志）；--minimized 改为最小化
set "QQB_WINDOW_STYLE=Normal"
if /i "%~1"=="--minimized" set "QQB_WINDOW_STYLE=Minimized"
if /i "%~1"=="--foreground" set "QQB_FOREGROUND=1"

if /i "%~1"=="--daemon" goto daemon

rem ── 前置检查 ───────────────────────────────────────────────────────────────
if not exist "src\bridge.js" (
  echo [错误] 当前目录找不到 src\bridge.js，restart.bat 必须放在 bridge 目录里。
  pause
  exit /b 1
)
where node >nul 2>&1 || (
  echo [错误] 找不到 node 命令，请先安装 Node.js 22.13+ 并加入 PATH。
  pause
  exit /b 1
)

rem ── 读取控制台端口（config.json 的 consolePort，默认 3100） ────────────────
set "PORT=3100"
for /f "tokens=2 delims=:," %%a in ('findstr /i "consolePort" "config.json" 2^>nul') do (
  set "RAW=%%a"
  set "RAW=!RAW: =!"
  if not "!RAW!"=="" set "PORT=!RAW!"
)

echo.
echo == qq-bridge 重启 =========================================================
echo 目录：%QQB_BRIDGE_ROOT%
echo.

rem ── 1. 停止旧守护进程与旧桥接进程 ─────────────────────────────────────────
echo [1/4] 停止旧守护进程与旧桥接进程…
set "QQB_RESTART_PHASE=stop"
call :run_ps
if errorlevel 1 echo       [警告] 停止阶段返回异常，继续尝试启动。

rem ── 2. 清理过期锁 ─────────────────────────────────────────────────────────
echo [2/4] 清理过期锁…
del /f /q "state\bridge.lock" >nul 2>&1
del /f /q "state\bridge-daemon.pid" >nul 2>&1
del /f /q "state\.restart-up.txt" >nul 2>&1

rem ── 3.（--foreground）直接在当前窗口前台守护，最接近 npm.cmd start ──────────
if defined QQB_FOREGROUND (
  echo [3/4] 前台守护：桥接日志显示在本窗口，Ctrl+C 或关闭窗口即停止。
  echo.
  goto daemon
)

rem ── 3. 启动守护窗口（可见，关闭该窗口即停止） ────────────────────────────
rem 用 PowerShell 的 Start-Process 启动：它不继承本窗口被重定向的 stdout，
rem 这样 restart.bat 被双击、或在管道/日志重定向下调用都能正常返回。
echo [3/4] 启动守护窗口（日志可见，关闭该窗口即停止）…
set "QQB_RESTART_PHASE=start"
call :run_ps
if errorlevel 1 echo       [警告] 启动守护失败；可手动运行：node src\bridge.js

rem ── 4. 等待桥接就绪（单实例锁建立且 PID 是 node src\bridge.js） ────────────
echo [4/4] 等待桥接就绪（最长 30 秒）…
set "QQB_RESTART_PHASE=verify"
call :run_ps
set "READY="
if not errorlevel 1 set "READY=1"
set "NEWPID="
if exist "state\.restart-up.txt" set /p "NEWPID="<"state\.restart-up.txt" 2>nul

echo.
if defined READY (
  echo 已启动。PID !NEWPID!；控制台：http://127.0.0.1:!PORT!
  echo 日志：state\bridge.log；守护输出：state\start-daemon.log
  echo 守护窗口：qq-bridge-daemon（日志实时显示；关闭该窗口即停止桥接；加 --minimized 则最小化到任务栏）。
) else (
  echo [警告] 30 秒内没有等到桥接就绪（单实例锁未建立或控制台端口未监听）。
  echo         请查看 state\bridge.log 与 state\start-daemon.log；
  echo         也可以在当前目录手动运行：node src\bridge.js
)
echo ============================================================================
del /f /q "state\.restart-up.txt" >nul 2>&1

rem 双击运行时留几秒看结果；timeout 在输入被重定向时会立即返回，不会卡住自动化
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul
if not errorlevel 1 timeout /t 10 >nul 2>&1

endlocal
exit /b 0

rem ============================================================================
rem  内部函数：从本文件尾部提取 PowerShell 代码并执行
rem  （批处理直接内联长 PowerShell 单行会被括号、引号规则拆坏，故用此法）
rem ============================================================================
:run_ps
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $s=[IO.File]::ReadAllText($env:QQB_SELF,[Text.Encoding]::UTF8); $m='#PS'+':BRIDGE:'; $i=$s.LastIndexOf($m); if ($i -ge 0) { Invoke-Expression $s.Substring($i + $m.Length) } }"
exit /b %errorlevel%

rem ============================================================================
rem  守护模式（内部用）：循环拉起 src\bridge.js，崩溃后 5 秒重试
rem  exit 2 = 已有实例在运行，不再重启（与 start.sh 语义一致）
rem  exit 0 = 桥接正常退出（Ctrl+C / 关窗口），守护一起退出，不再拉起
rem ============================================================================
:daemon
title qq-bridge-daemon（关闭本窗口即停止桥接）
cd /d "%~dp0"
set "QQB_BRIDGE_ROOT=%~dp0"
>>"state\start-daemon.log" echo [%date% %time%] 守护启动
:loop
node "src\bridge.js"
set "CODE=%errorlevel%"
if "%CODE%"=="2" (
  >>"state\start-daemon.log" echo [%date% %time%] 桥接报告已有实例在运行（exit 2），守护退出
  exit /b 2
)
if "%CODE%"=="0" (
  >>"state\start-daemon.log" echo [%date% %time%] 桥接正常退出（code 0，可能是 Ctrl+C），守护退出
  exit /b 0
)
>>"state\start-daemon.log" echo [%date% %time%] 桥接退出（code %CODE%），5 秒后重新拉起
ping -n 6 127.0.0.1 >nul 2>&1
goto :loop

rem ============================================================================
rem  以下为 PowerShell 实现（由 :run_ps 通过读取本文件尾部提取执行）
rem  阶段由环境变量 QQB_RESTART_PHASE 控制：
rem    stop   = 停掉旧守护与旧桥接
rem    start  = 用独立进程（不继承句柄）启动守护窗口（默认可见，--minimized 则最小化）
rem    verify = 等桥接就绪（单实例锁 + 端口）
rem ============================================================================
#PS:BRIDGE:
$ErrorActionPreference = 'SilentlyContinue'
$root = $env:QQB_BRIDGE_ROOT
if (-not $root) { $root = (Get-Location).Path }
$root = (Resolve-Path -LiteralPath $root).Path.TrimEnd('\')
$rootNorm = ($root -replace '\\', '/').ToLower()
$phase = $env:QQB_RESTART_PHASE

function Get-ConsolePort {
  $port = 3100
  $configPath = Join-Path $root 'config.json'
  if (Test-Path -LiteralPath $configPath) {
    try {
      $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.consolePort) { $port = [int]$cfg.consolePort }
    } catch {}
  }
  return $port
}

# 端口监听者 PID：用 netstat 解析。Get-NetTCPConnection 在本机每次约 6 秒，太慢。
function Get-PortListenerPids([int]$Port) {
  $pids = New-Object 'System.Collections.Generic.HashSet[int]'
  try {
    foreach ($line in (& netstat -ano)) {
      if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
        if ([int]$Matches[1] -eq $Port) { [void]$pids.Add([int]$Matches[2]) }
      }
    }
  } catch {}
  return @($pids)
}

# 端口是否仍在监听：用 .NET 快查（比 Get-NetTCPConnection 快两个数量级）。
function Test-PortListening([int]$Port) {
  try {
    foreach ($endpoint in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
      if ($endpoint.Port -eq $Port) { return $true }
    }
  } catch {}
  return $false
}

function Test-IsBridgeProcess([int]$TargetProcessId) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId" -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  if ($proc.Name -ine 'node.exe') { return $false }
  $cmd = [string]$proc.CommandLine
  if (-not $cmd) { return $false }
  if ($cmd -notmatch 'bridge\.js') { return $false }
  if ($cmd -match 'mcp-') { return $false }
  return $true
}

function Test-IsOurDaemon([string]$CommandLine) {
  if (-not $CommandLine) { return $false }
  $norm = ($CommandLine -replace '\\', '/').ToLower()
  return ($norm.Contains($rootNorm) -and $norm.Contains('restart.bat'))
}

function Stop-OldInstances {
  # ── 1) 停止本脚本拉起的守护窗口（先窗口标题，再 pid 文件，最后命令行兜底） ──
  $daemons = New-Object 'System.Collections.Generic.HashSet[int]'
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'qq-bridge-daemon*' } | ForEach-Object { [void]$daemons.Add([int]$_.Id) }
  $daemonPidPath = Join-Path $root 'state\bridge-daemon.pid'
  if (Test-Path -LiteralPath $daemonPidPath) {
    try {
      $dp = 0
      if ([int]::TryParse((Get-Content -LiteralPath $daemonPidPath -Raw).Trim(), [ref]$dp)) { [void]$daemons.Add($dp) }
    } catch {}
  }
  # 标题和 pid 文件都没找到时，再按命令行全量兜底（CIM 枚举较慢，正常情况用不到）
  if ($daemons.Count -eq 0) {
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { Test-IsOurDaemon ([string]$_.CommandLine) } | ForEach-Object { [void]$daemons.Add([int]$_.ProcessId) }
  }
  $stoppedDaemons = 0
  foreach ($daemonPid in $daemons) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$daemonPid" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if (-not (Test-IsOurDaemon ([string]$proc.CommandLine))) { continue }
    Write-Host "      停止旧守护进程（PID $daemonPid）"
    & taskkill /F /T /PID $daemonPid 2>$null | Out-Null
    $stoppedDaemons++
  }
  Remove-Item -LiteralPath $daemonPidPath -Force -ErrorAction SilentlyContinue
  if ($stoppedDaemons -eq 0) { Write-Host '      没有发现运行中的守护进程' }

  # ── 2) 停止旧桥接：锁文件 PID + 控制台端口监听者，逐个校验命令行再动 ──────
  $port = Get-ConsolePort
  $targets = New-Object 'System.Collections.Generic.HashSet[int]'
  $lockPath = Join-Path $root 'state\bridge.lock'
  if (Test-Path -LiteralPath $lockPath) {
    try {
      $lockPid = 0
      if ([int]::TryParse((Get-Content -LiteralPath $lockPath -Raw).Trim(), [ref]$lockPid)) { [void]$targets.Add($lockPid) }
    } catch {}
  }
  foreach ($listenerPid in Get-PortListenerPids $port) { [void]$targets.Add([int]$listenerPid) }
  $killed = 0
  foreach ($targetPid in $targets) {
    if (Test-IsBridgeProcess $targetPid) {
      Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
      Write-Host "      已停止旧桥接进程（PID $targetPid）"
      $killed++
    }
  }
  if ($killed -eq 0) { Write-Host '      没有发现运行中的桥接进程' }

  # ── 3) 等控制台端口真正释放（最多 10 秒） ─────────────────────────────────
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-PortListening $port)) { break }
    Start-Sleep -Milliseconds 250
  }
}

function Start-DaemonWindow {
  $inner = '/d /c ""' + $env:QQB_SELF + '" --daemon"'
  $comspec = $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })
  $windowStyle = 'Normal'
  if ($env:QQB_WINDOW_STYLE -eq 'Minimized') { $windowStyle = 'Minimized' }
  $daemon = Start-Process -FilePath $comspec -ArgumentList $inner -WorkingDirectory $root -WindowStyle $windowStyle -PassThru
  if (-not $daemon) { return $false }
  $pidPath = Join-Path $root 'state\bridge-daemon.pid'
  New-Item -ItemType Directory -Path (Split-Path -Parent $pidPath) -Force | Out-Null
  Set-Content -LiteralPath $pidPath -Value $daemon.Id -Encoding Ascii
  Write-Host "      守护进程已启动（PID $($daemon.Id)）"
  return $true
}

function Wait-BridgeReady {
  $deadline = (Get-Date).AddSeconds(30)
  $lockPath = Join-Path $root 'state\bridge.lock'
  $outPath = Join-Path $root 'state\.restart-up.txt'
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $lockPath) {
      try {
        $lockPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $lockPath -Raw).Trim(), [ref]$lockPid) -and (Test-IsBridgeProcess $lockPid)) {
          New-Item -ItemType Directory -Path (Split-Path -Parent $outPath) -Force | Out-Null
          Set-Content -LiteralPath $outPath -Value $lockPid -Encoding Ascii
          return $true
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

switch ($phase) {
  'stop' {
    Stop-OldInstances
    exit 0
  }
  'start' {
    if (Start-DaemonWindow) { exit 0 } else { exit 1 }
  }
  'verify' {
    if (Wait-BridgeReady) { exit 0 } else { exit 1 }
  }
  default { exit 2 }
}
