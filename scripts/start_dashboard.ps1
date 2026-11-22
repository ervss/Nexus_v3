param(
    [int]$Port = 8000,
    [ValidateSet('dev','prod')]
    [string]$Mode = 'dev',
    [switch]$Smoke,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$AppDir = $ProjectRoot
$SmokeScript = Join-Path $PSScriptRoot 'smoke_dashboard.ps1'

function Resolve-PythonCommand {
    if (Test-Path $VenvPython) {
        try {
            & $VenvPython --version *> $null
            return @($VenvPython)
        } catch {
            Write-Warning "Venv Python launcher is not executable: $VenvPython"
        }
    }

    $KnownPythonRoots = @(
        (Join-Path $HOME 'AppData\Local\Programs\Python\Python312\python.exe'),
        (Join-Path $HOME 'AppData\Local\Programs\Python\Python311\python.exe')
    )
    foreach ($CandidatePython in $KnownPythonRoots) {
        if (Test-Path $CandidatePython) {
            try {
                & $CandidatePython --version *> $null
                return @($CandidatePython)
            } catch {}
        }
    }

    try {
        & py -3.12 --version *> $null
        return @('py', '-3.12')
    } catch {}

    $LocalPy = Join-Path $HOME '.local\bin\py.cmd'
    if (Test-Path $LocalPy) {
        try {
            & $LocalPy -3.12 --version *> $null
            return @($LocalPy, '-3.12')
        } catch {}
    }

    try {
        & python --version *> $null
        return @('python')
    } catch {}

    $LocalPython = Join-Path $HOME '.local\bin\python.cmd'
    if (Test-Path $LocalPython) {
        try {
            & $LocalPython --version *> $null
            return @($LocalPython)
        } catch {}
    }

    throw "No working Python launcher found. Checked venv python, 'py -3.12', local .local launchers, and 'python'."
}

$PythonCmd = @(Resolve-PythonCommand)
$PythonExe = $PythonCmd[0]
$PythonPrefixArgs = @()
if ($PythonCmd.Length -gt 1) {
    $PythonPrefixArgs = $PythonCmd[1..($PythonCmd.Length - 1)]
}

$env:SERVER_PORT = "$Port"

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $ownerPid = $listener.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
    Write-Host "Port $Port is already in use by PID $ownerPid ($($proc.Name))."
    Write-Host "If this is your dashboard server, open: http://127.0.0.1:$Port/login"
    if ($Smoke -and (Test-Path $SmokeScript)) {
        Write-Host "Running smoke checks against existing server..."
        & $SmokeScript -BaseUrl "http://127.0.0.1:$Port"
    }
    exit 0
}

$args = @('-m', 'uvicorn', 'app.main:app', '--app-dir', $AppDir, '--host', '127.0.0.1', '--port', "$Port")
if ($Mode -eq 'dev') { $args += '--reload' }

Write-Host "Starting dashboard on http://127.0.0.1:$Port/login"
Write-Host "Mode: $Mode"
Write-Host "App dir: $AppDir"
Write-Host "Terminal log: logs\server\latest-$Port.log (also archived per run)"
if ($Mode -eq 'dev') {
    Write-Host "Hot reload: enabled"
} else {
    Write-Host "Hot reload: disabled"
}

if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:$Port/login" | Out-Null
}

& $PythonExe @PythonPrefixArgs @args
