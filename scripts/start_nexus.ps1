param(
    [ValidateSet('classic', 'lite')][string]$Mode = 'classic',
    [int]$Port = 8000,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) { $Python = 'python' }
if ($Port -eq 0) { $Port = 8000 }
Set-Location $ProjectRoot
$Url = "http://127.0.0.1:$Port"
function Start-NexusTray {
    $TrayExecutable = Join-Path $PSScriptRoot 'bin\NexusTray.exe'
    $TraySource = Join-Path $PSScriptRoot 'NexusTrayHost.cs'
    if ((Test-Path -LiteralPath $TrayExecutable) -and
        (Get-Item -LiteralPath $TrayExecutable).LastWriteTimeUtc -ge (Get-Item -LiteralPath $TraySource).LastWriteTimeUtc) {
        Start-Process -FilePath $TrayExecutable -ArgumentList @('--port', "$Port", '--mode', $Mode) -WindowStyle Hidden
        return
    }
    $WindowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $TrayBuilder = Join-Path $PSScriptRoot 'build_tray.ps1'
    $Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $TrayBuilder + '" -Launch -Port ' + $Port + ' -Mode ' + $Mode
    Start-Process -FilePath $WindowsPowerShell -ArgumentList $Arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}
function Test-Nexus {
    try {
        $reply = Invoke-RestMethod "$Url/_nexus/live" -TimeoutSec 2
        return $reply.service -eq 'nexus'
    } catch { return $false }
}
function Start-SearxngBackground {
    $SearxScript = Join-Path $PSScriptRoot 'start_searxng.ps1'
    if (Test-Path -LiteralPath $SearxScript) {
        try { & $SearxScript -WaitSeconds 12 } catch { Write-Warning $_ }
    }
}
Start-NexusTray
if (Test-Nexus) {
    Start-SearxngBackground
    Write-Host "Nexus odpoveda na $Url." -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $Url }
    exit 0
}
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    throw "Port $Port drzi PID $($listener.OwningProcess), ale Nexus neodpoveda. Zastav povodny Nexus cez STOP_NEXUS.bat."
}
$LogDir = Join-Path $ProjectRoot 'logs\server'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Runner = Join-Path $PSScriptRoot 'nexus_server.py'
$Supervisor = Start-Process -FilePath $Python -ArgumentList @('"' + $Runner + '"', '--mode', $Mode, '--port', "$Port") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$LogDir\supervisor-launch-$Port.log" -RedirectStandardError "$LogDir\supervisor-launch-$Port.err.log"
$Deadline = (Get-Date).AddSeconds(130)
do {
    if (Test-Nexus) {
        Start-SearxngBackground
        Write-Host "Nexus je pripraveny na $Url; dohled PID $($Supervisor.Id)." -ForegroundColor Green
        if (-not $NoBrowser) {
            try { & (Join-Path $PSScriptRoot 'start_filester.ps1') -OpenBrowser } catch { Write-Warning $_ }
            Start-Process $Url
        }
        exit 0
    }
    $Supervisor.Refresh()
    if ($Supervisor.HasExited) { throw "Dohled skoncil. Pozri logs/server/supervisor-launch-$Port.err.log" }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $Deadline)
throw "Nexus sa nepripravil vcas. Pozri logs/server/supervisor-$Port.log; dohled zostava aktivny."
