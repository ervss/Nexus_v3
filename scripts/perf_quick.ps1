param(
    [string]$BaseUrl = "http://127.0.0.1:8001",
    [int]$Iterations = 15
)

$ErrorActionPreference = 'Stop'

function Measure-Endpoint([string]$Name, [string]$Url, [int]$N) {
    $times = @()
    for ($i = 0; $i -lt $N; $i++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $null = Invoke-WebRequest -Uri $Url -Method GET -UseBasicParsing
            $sw.Stop()
            $times += $sw.Elapsed.TotalMilliseconds
        } catch {
            $sw.Stop()
        }
    }

    if ($times.Count -eq 0) {
        return [pscustomobject]@{ Endpoint = $Name; Samples = 0; AvgMs = -1; P95Ms = -1; MaxMs = -1 }
    }

    $sorted = $times | Sort-Object
    $p95Index = [Math]::Ceiling($sorted.Count * 0.95) - 1
    if ($p95Index -lt 0) { $p95Index = 0 }

    [pscustomobject]@{
        Endpoint = $Name
        Samples = $sorted.Count
        AvgMs = [Math]::Round(($times | Measure-Object -Average).Average, 2)
        P95Ms = [Math]::Round($sorted[$p95Index], 2)
        MaxMs = [Math]::Round(($times | Measure-Object -Maximum).Maximum, 2)
    }
}

Write-Host "Running quick perf probe against $BaseUrl with $Iterations iterations per endpoint..."

$report = @()
$report += Measure-Endpoint -Name 'health' -Url "$BaseUrl/health" -N $Iterations
$report += Measure-Endpoint -Name 'login' -Url "$BaseUrl/login" -N $Iterations
$report += Measure-Endpoint -Name 'static_css' -Url "$BaseUrl/static/style.css" -N $Iterations

$report | Format-Table -AutoSize

$degraded = $report | Where-Object { $_.AvgMs -gt 800 -or $_.P95Ms -gt 1500 -or $_.Samples -eq 0 }
if ($degraded.Count -gt 0) {
    Write-Host 'Quick perf result: DEGRADED (check endpoint latencies above).' -ForegroundColor Yellow
    exit 1
}

Write-Host 'Quick perf result: OK.' -ForegroundColor Green
