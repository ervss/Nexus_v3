param([int]$Port = 8000, [switch]$Force)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) { $Python = 'python' }
$Arguments = @((Join-Path $PSScriptRoot 'nexus_control.py'), 'stop', '--port', "$Port")
if ($Force) { $Arguments += '--force' }
$Reply = & $Python @Arguments
if (-not $Reply) { throw 'Ovládanie nevrátilo stav; skontroluj Python prostredie.' }
$Result = $Reply | ConvertFrom-Json
if (-not $Result.ok) {
    if ($Result.needs_force) { throw "$($Result.message) Pre výslovne vynútené zastavenie použi scripts\stop_nexus.ps1 -Force." }
    throw $Result.message
}
Write-Host $Result.message
