param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [int]$PerfIterations = 10,
    [switch]$SkipPerf
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DbScript = Join-Path $PSScriptRoot 'check_db.py'
$SmokeScript = Join-Path $PSScriptRoot 'smoke_dashboard.ps1'
$PerfScript = Join-Path $PSScriptRoot 'perf_quick.ps1'

function Resolve-PythonExe([string]$Root) {
    $candidates = @(
        (Join-Path $Root '.venv\Scripts\python.exe'),
        (Join-Path $Root '.venv_fix\Scripts\python.exe'),
        'C:\Users\Peto\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    )

    foreach ($candidate in $candidates) {
        if (-not (Test-Path $candidate)) { continue }
        try {
            & $candidate --version 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch {
            continue
        }
    }

    return $null
}

$PythonExe = Resolve-PythonExe -Root $ProjectRoot

function Invoke-Step([string]$Name, [scriptblock]$Command) {
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    try {
        & $Command | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Host "${Name}: FAIL (exit code $LASTEXITCODE)" -ForegroundColor Red
            return [pscustomobject]@{ Name = $Name; Ok = $false; ExitCode = $LASTEXITCODE }
        }
        Write-Host "${Name}: PASS" -ForegroundColor Green
        return [pscustomobject]@{ Name = $Name; Ok = $true; ExitCode = 0 }
    } catch {
        Write-Host "${Name}: FAIL ($($_.Exception.Message))" -ForegroundColor Red
        return [pscustomobject]@{ Name = $Name; Ok = $false; ExitCode = 1 }
    }
}

if (-not (Test-Path $PythonExe)) {
    Write-Error "No functional Python interpreter found (.venv or bundled runtime)."
    exit 1
}

if (-not (Test-Path $DbScript)) {
    Write-Error "Missing script: $DbScript"
    exit 1
}
if (-not (Test-Path $SmokeScript)) {
    Write-Error "Missing script: $SmokeScript"
    exit 1
}
if (-not $SkipPerf -and -not (Test-Path $PerfScript)) {
    Write-Error "Missing script: $PerfScript"
    exit 1
}

$steps = @()

$steps += Invoke-Step -Name 'Database Check' -Command {
    & $PythonExe $DbScript
}

$steps += Invoke-Step -Name 'Smoke Check' -Command {
    powershell -ExecutionPolicy Bypass -File $SmokeScript -BaseUrl $BaseUrl
}

if (-not $SkipPerf) {
    $steps += Invoke-Step -Name 'Quick Performance Check' -Command {
        powershell -ExecutionPolicy Bypass -File $PerfScript -BaseUrl $BaseUrl -Iterations $PerfIterations
    }
} else {
    Write-Host "`n=== Quick Performance Check ===" -ForegroundColor Cyan
    Write-Host 'Quick Performance Check: SKIPPED' -ForegroundColor Yellow
}

$failed = $steps | Where-Object { -not $_.Ok }

Write-Host "`n===================================="
if ($failed.Count -eq 0) {
    Write-Host 'NEXUS VALIDATION: PASS' -ForegroundColor Green
    exit 0
}

Write-Host "NEXUS VALIDATION: FAIL ($($failed.Count) step(s))" -ForegroundColor Red
$failed | ForEach-Object { Write-Host " - $($_.Name)" -ForegroundColor Red }
exit 1
