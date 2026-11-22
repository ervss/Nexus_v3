param([switch]$NoBrowser)
$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $projectDir ".venv\Scripts\python.exe"
$requirements = Join-Path $projectDir "requirements.txt"

$Host.UI.RawUI.WindowTitle = "Filester Search server :8765"
Set-Location -LiteralPath $projectDir

Write-Host "Filester Search" -ForegroundColor Cyan
Write-Host "Server: http://127.0.0.1:8765" -ForegroundColor DarkGray
Write-Host ""

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
    if ($health.ok -and $health.backend -eq "filester_api") {
        if (-not $NoBrowser) { Start-Process "http://127.0.0.1:8765/ui/dashboard.html" }
        Write-Host "Filester Search uz bezi na porte 8765." -ForegroundColor Green
        Write-Host "Toto okno mozes zavriet." -ForegroundColor DarkGray
        Read-Host "Stlac Enter"
        exit 0
    }
} catch {
    # Port is free or the service is not the Filester backend; continue below.
}

if (-not (Test-Path -LiteralPath $python)) {
    Write-Host "Prve spustenie: vytvaram virtualne prostredie..." -ForegroundColor Yellow
    & py -3.12 -m venv (Join-Path $projectDir ".venv")
    if ($LASTEXITCODE -ne 0) { throw "Nepodarilo sa vytvorit .venv cez Python 3.12." }

    Write-Host "Instalujem zavislosti..." -ForegroundColor Yellow
    & $python -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "Instalacia requirements.txt zlyhala." }
}

Write-Host "Spustam backend. Toto okno nechaj otvorene." -ForegroundColor Green
Write-Host "Server zastavis zatvorenim okna alebo Ctrl+C." -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) {
    $browserJob = Start-Job -ScriptBlock {
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $ready = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 1
                if ($ready.ok -and $ready.backend -eq "filester_api") {
                    Start-Process "http://127.0.0.1:8765/ui/dashboard.html"
                    return
                }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
    }
}

& $python "filester_api.py"

if ($browserJob) { Stop-Job -Job $browserJob -ErrorAction SilentlyContinue; Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue }

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Filester Search skoncil s chybou (kod $LASTEXITCODE)." -ForegroundColor Red
    Read-Host "Stlac Enter"
}
