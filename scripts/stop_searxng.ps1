param([int]$Port = 8888)

$ErrorActionPreference = 'Stop'

$stopped = $false
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match 'searx|webapp\.py') {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "SearXNG zastaveny (PID $($listener.OwningProcess))." -ForegroundColor Green
        $stopped = $true
    }
}

if (-not $stopped) {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine -match 'SearXNGforWindows.*webapp\.py'
    }
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "SearXNG zastaveny (PID $($p.ProcessId))." -ForegroundColor Green
        $stopped = $true
    }
}

if (-not $stopped) {
    Write-Host "SearXNG na porte $Port nebezi."
}
