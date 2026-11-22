param(
  [string]$ExtensionId
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostDir = Join-Path $root "host"
$manifestPath = Join-Path $hostDir "com.article_saver.trafilatura.json"
$launcher = Join-Path $hostDir "start_host.bat"
if (!(Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Python launcher 'py' nebol nájdený. Nainštaluj Python z python.org a zaškrtni Python launcher."
}
& py -3 -m pip install --user trafilatura requests
if ($LASTEXITCODE -ne 0) { throw "Inštalácia Python balíkov zlyhala." }
if (-not $ExtensionId) {
  $ExtensionId = Read-Host "Vlož 32-znakové ID rozšírenia z chrome://extensions (po Load unpacked)"
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "Neplatné ID rozšírenia; Chrome ID má 32 znakov od a po p."
}
$native = @{
  name = "com.article_saver.trafilatura"
  description = "Trafilatura native host pre Article Saver"
  path = $launcher
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($native | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.article_saver.trafilatura"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Host "Host zaregistrovaný: $manifestPath"
Write-Host "Chrome ID: $ExtensionId"
Write-Host "Reštartuj Chrome a vyskúšaj Uložiť článok."
