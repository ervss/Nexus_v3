param([switch]$OpenBrowser)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$FilesterDir = Join-Path $ProjectRoot 'extension\filester_search'
$Python = Join-Path $FilesterDir '.venv\Scripts\python.exe'
$HealthUrl = 'http://127.0.0.1:8765/health'
$DashboardUrl = 'http://127.0.0.1:8765/ui/dashboard.html'

function Get-FilesterHealth {
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($health.ok -and $health.backend -eq 'filester_api') { return $health }
    } catch { }
    return $null
}

$health = Get-FilesterHealth
if ($health) {
    Write-Host 'Filester uz bezi na porte 8765.' -ForegroundColor Green
    if ($OpenBrowser) { Start-Process $DashboardUrl }
    return
}

$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Write-Warning "Port 8765 pouziva iny proces (PID $($listener.OwningProcess)); Filester sa nespustil."
    return
}

if (-not (Test-Path -LiteralPath $Python)) {
    Write-Warning "Filester Python prostredie sa nenaslo: $Python"
    return
}

$LogDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$StdoutLog = Join-Path $LogDir 'filester-server.log'
$StderrLog = Join-Path $LogDir 'filester-server-error.log'
# Python otherwise inherits the legacy Windows console code page. A folder
# title outside that code page must never be able to terminate discovery.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$process = Start-Process -FilePath $Python -ArgumentList @('filester_api.py') `
    -WorkingDirectory $FilesterDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($process.HasExited) {
        Write-Warning "Filester sa nespustil. Pozri log: $StderrLog"
        return
    }
    $health = Get-FilesterHealth
    if ($health) {
        Write-Host 'Filester bezi na porte 8765.' -ForegroundColor Green
        if ($OpenBrowser) { Start-Process $DashboardUrl }
        return
    }
    Start-Sleep -Milliseconds 500
}

Write-Warning "Filester sa neozval do 20 sekund. Log: $StderrLog"
