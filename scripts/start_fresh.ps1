# NexusPWC - Fresh Start Script
# Spusti toto ked zaciname v novom prostredi
# Pouzitie: cd C:\cesta\NexusPWC_fresh && .\scripts\start_fresh.ps1

param(
    [switch]$Reload
)

$root = Split-Path $PSScriptRoot

Write-Host "=== NexusPWC Fresh Start ===" -ForegroundColor Cyan

# 1. Python check
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { Write-Host "ERROR: Python not found in PATH" -ForegroundColor Red; exit 1 }
Write-Host "Python: $((python --version 2>&1))" -ForegroundColor Green

# 2. Pip install requirements
Write-Host "`nInstalling requirements..." -ForegroundColor Yellow
pip install -r "$root\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: Some requirements failed" -ForegroundColor Yellow }

# 3. Start dashboard on port 8000
Write-Host "`nStarting NexusPWC dashboard on http://localhost:8000 ..." -ForegroundColor Cyan
Write-Host "Terminal log: logs\server\latest-8000.log (also archived per run)" -ForegroundColor Yellow
if ($Reload) {
    Write-Host "Hot reload: enabled (development mode)" -ForegroundColor Yellow
} else {
    Write-Host "Hot reload: disabled (stable mode)" -ForegroundColor Green
}
Set-Location $root
$env:NEXUS_DB_PATH = "$root\nexus_fresh.db"
$env:LOG_TO_FILE = "true"
$uvicornArgs = @('-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8000')
if ($Reload) { $uvicornArgs += '--reload' }
python @uvicornArgs
