param(
    [string]$BaseUrl = "http://127.0.0.1:8001"
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ProjectRoot '.env'

function Get-EnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path $Path)) { return $null }
    $line = Get-Content $Path | Where-Object {
        $_ -match "^\s*$Key="
    } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

function Test-Endpoint([string]$Name, [scriptblock]$Call) {
    try {
        $code = & $Call
        [pscustomobject]@{ Check = $Name; Code = $code; Ok = ($code -ge 200 -and $code -lt 400) }
    } catch {
        [pscustomobject]@{ Check = $Name; Code = 'ERR'; Ok = $false }
    }
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$results = @()

$results += Test-Endpoint 'health' {
    (Invoke-WebRequest -Uri "$BaseUrl/health" -Method GET -UseBasicParsing -WebSession $session).StatusCode
}

$results += Test-Endpoint 'login_get' {
    (Invoke-WebRequest -Uri "$BaseUrl/login" -Method GET -UseBasicParsing -WebSession $session).StatusCode
}

$password = Get-EnvValue -Path $EnvPath -Key 'DASHBOARD_PASSWORD'
if ([string]::IsNullOrWhiteSpace($password)) {
    $results += [pscustomobject]@{ Check = 'login_post'; Code = 'SKIP'; Ok = $false }
} else {
    $body = @{ password = $password } | ConvertTo-Json -Compress
    $results += Test-Endpoint 'login_post' {
        (Invoke-WebRequest -Uri "$BaseUrl/login" -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing -WebSession $session).StatusCode
    }

    $results += Test-Endpoint 'root_after_login' {
        (Invoke-WebRequest -Uri "$BaseUrl/" -Method GET -UseBasicParsing -WebSession $session).StatusCode
    }
}

$results += Test-Endpoint 'static_css' {
    (Invoke-WebRequest -Uri "$BaseUrl/static/style.css" -Method GET -UseBasicParsing -WebSession $session).StatusCode
}

$results += Test-Endpoint 'import_bulk_options' {
    (Invoke-WebRequest -Uri "$BaseUrl/api/v1/import/bulk" -Method OPTIONS -Headers @{ Origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; 'Access-Control-Request-Method' = 'POST' } -UseBasicParsing).StatusCode
}

$results | Format-Table -AutoSize

$failed = $results | Where-Object { -not $_.Ok }
if ($failed.Count -gt 0) {
    Write-Host "Smoke check FAILED ($($failed.Count) checks)." -ForegroundColor Red
    exit 1
}

Write-Host 'Smoke check PASSED.' -ForegroundColor Green
