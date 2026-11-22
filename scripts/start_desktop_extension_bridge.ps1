param(
    [string]$RemoteUrl = 'http://Olinka:8000'
)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
python .\scripts\nexus_desktop_extension_bridge.py --remote $RemoteUrl
