$ErrorActionPreference = 'Stop'
# Preserve Python's existing TCP blocks for every port except Nexus.
$pythonPath = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
Get-NetFirewallRule -Enabled True -Direction Inbound -Action Block | Where-Object {
    $_.Profile -eq 'Private'
} | ForEach-Object {
    $rule = $_
    $application = $rule | Get-NetFirewallApplicationFilter
    $port = $rule | Get-NetFirewallPortFilter
    if ($application.Program -ieq $pythonPath -and $port.Protocol -eq 'TCP' -and $port.LocalPort -eq 'Any') {
        $port | Set-NetFirewallPortFilter -LocalPort '1-7999','8001-65535' | Out-Null
    }
}
$name = 'Nexus-Mobile-LAN-8000'
if (-not (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $name -DisplayName 'Nexus mobile - home LAN TCP 8000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -LocalAddress 192.168.1.10 -RemoteAddress 192.168.1.0/24 -Profile Private -Program $pythonPath | Out-Null
}
Write-Host 'Nexus mobile LAN firewall configured.'
