param(
    [int]$Port = 8888,
    [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SearxDir = if ($env:SEARXNG_DIR -and (Test-Path -LiteralPath $env:SEARXNG_DIR)) {
    $env:SEARXNG_DIR
} else {
    Join-Path $env:USERPROFILE 'Apps\searxng-win\SearXNGforWindows-main'
}
$ProbeUrl = "http://127.0.0.1:$Port/search?q=ping&format=json"

function Test-Searxng {
    try {
        $resp = Invoke-WebRequest -Uri $ProbeUrl -UseBasicParsing -TimeoutSec 2
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-Searxng) {
    Write-Host "SearXNG uz bezi na porte $Port." -ForegroundColor Green
    exit 0
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Write-Warning "Port $Port drzi iny proces (PID $($listener.OwningProcess)); SearXNG sa nespustil."
    exit 1
}

if (-not (Test-Path -LiteralPath $SearxDir)) {
    Write-Warning "SearXNG priecinok sa nenasiel: $SearxDir (Dork vrstva bude bez SearXNG vypnuta)."
    exit 0
}

$Python = Join-Path $SearxDir 'python\python.exe'
$WebApp = Join-Path $SearxDir 'python\Lib\site-packages\searx\webapp.py'
if (-not (Test-Path -LiteralPath $Python) -or -not (Test-Path -LiteralPath $WebApp)) {
    Write-Warning "SearXNG spustacie subory sa nenasli v $SearxDir."
    exit 0
}

$LogDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$StdoutLog = Join-Path $LogDir 'searxng-server.log'
$StderrLog = Join-Path $LogDir 'searxng-server-error.log'

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:SEARXNG_SETTINGS_PATH = Join-Path $SearxDir 'config\settings.yml'

$proc = Start-Process -FilePath $Python -ArgumentList @("`"$WebApp`"") `
    -WorkingDirectory $SearxDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog

$attempts = [Math]::Max(1, $WaitSeconds * 2)
for ($i = 0; $i -lt $attempts; $i++) {
    if ($proc.HasExited) {
        Write-Warning "SearXNG skoncil predcasne. Pozri log: $StderrLog"
        exit 1
    }
    if (Test-Searxng) {
        Write-Host "SearXNG pripraveny na http://127.0.0.1:$Port (PID $($proc.Id))." -ForegroundColor Green
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

Write-Warning "SearXNG sa spusta na pozadi (port $Port este neodpovedal do ${WaitSeconds}s)."
exit 0
