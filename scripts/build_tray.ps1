param([switch]$Launch, [int]$Port = 8000, [ValidateSet('classic', 'lite')][string]$Mode = 'classic')
$ErrorActionPreference = 'Stop'
$BinaryDir = Join-Path $PSScriptRoot 'bin'
$Executable = Join-Path $BinaryDir 'NexusTray.exe'
$Source = Join-Path $PSScriptRoot 'NexusTrayHost.cs'
$Compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$WindowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Automation = (& $WindowsPowerShell -NoProfile -Command '[System.Management.Automation.PSObject].Assembly.Location').Trim()
New-Item -ItemType Directory -Force -Path $BinaryDir | Out-Null
if (-not (Test-Path -LiteralPath $Executable) -or (Get-Item $Source).LastWriteTimeUtc -gt (Get-Item $Executable).LastWriteTimeUtc) {
    & $Compiler /nologo /target:winexe /platform:x64 ('/out:' + $Executable) ('/reference:' + $Automation) /reference:System.Windows.Forms.dll $Source
    if ($LASTEXITCODE -ne 0) { throw 'Kompilácia Windows launchera zlyhala.' }
}
if ($Launch) { Start-Process -FilePath $Executable -ArgumentList @('--port', "$Port", '--mode', $Mode) -WindowStyle Hidden }
