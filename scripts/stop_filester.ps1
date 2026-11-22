$ErrorActionPreference = 'Stop'
$HealthUrl = 'http://127.0.0.1:8765/health'

try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
    if (-not ($health.ok -and $health.backend -eq 'filester_api')) {
        Write-Host 'Na porte 8765 nebezi Filester; nic sa nezastavilo.'
        return
    }
} catch {
    Write-Host 'Filester nebezi.'
    return
}

$listeners = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -match 'filester_api\.py|filester_api:app') {
        Stop-Process -Id $listener.OwningProcess -Force
        Write-Host "Filester zastaveny (PID $($listener.OwningProcess))." -ForegroundColor Green
        return
    }
}

Write-Warning 'Filester odpoveda na /health, ale jeho proces sa nepodarilo bezpecne identifikovat.'