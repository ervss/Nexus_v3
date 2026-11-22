param(
    [ValidateRange(1, 55535)][int]$Port = 8000,
    [ValidateSet('classic', 'lite')][string]$Mode = 'classic',
    [switch]$ShowPanel,
    [switch]$NoStartup
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
if ($env:NEXUS_TRAY_PYTHON) { $Python = $env:NEXUS_TRAY_PYTHON }
if (-not (Test-Path -LiteralPath $Python)) { throw 'Chýba .venv\Scripts\python.exe.' }
$Helper = Join-Path $PSScriptRoot 'nexus_control.py'
$LogDir = Join-Path $ProjectRoot 'logs\server'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Hash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$($ProjectRoot.ToLowerInvariant())|$Port"))).Replace('-', '').Substring(0, 16)
$Mutex = New-Object System.Threading.Mutex($false, "Local\NexusTray-$Hash")
if (-not $Mutex.WaitOne(0)) { $Mutex.Dispose(); exit 0 }
$SettingsPath = Join-Path $LogDir "tray-settings-$Port.json"
$Settings = @{ startup = -not $NoStartup }
if (Test-Path -LiteralPath $SettingsPath) {
    try { $Settings.startup = [bool](Get-Content -Raw -LiteralPath $SettingsPath | ConvertFrom-Json).startup } catch { }
}
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) "Nexus-$Hash.lnk"
$Launcher = Join-Path $ProjectRoot 'START_NEXUS_TRAY.vbs'

function Set-TrayStartup([bool]$Enabled) {
    if ($Enabled) {
        $Shell = New-Object -ComObject WScript.Shell
        $Shortcut = $Shell.CreateShortcut($StartupLink)
        $Shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $Shortcut.Arguments = '"' + $Launcher + '" ' + $Port + ' ' + $Mode
        $Shortcut.WorkingDirectory = $ProjectRoot
        $Shortcut.Description = 'Nexus: iba stavová ikonka, bez spustenia servera'
        $Shortcut.Save()
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($Shell) | Out-Null
    } elseif (Test-Path -LiteralPath $StartupLink) {
        Remove-Item -LiteralPath $StartupLink
    }
    $Settings.startup = $Enabled
    $Settings | ConvertTo-Json | Set-Content -LiteralPath $SettingsPath -Encoding UTF8
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexusIconHandle {
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
}
'@
function New-ServerIcon([Drawing.Color]$Color) {
    $Bitmap = New-Object Drawing.Bitmap(32, 32)
    $Graphics = [Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $Brush = New-Object Drawing.SolidBrush($Color)
    $DarkBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(28, 30, 34))
    $Graphics.FillRectangle($Brush, 5, 4, 22, 10)
    $Graphics.FillRectangle($Brush, 5, 18, 22, 10)
    $Graphics.FillEllipse($DarkBrush, 8, 7, 4, 4)
    $Graphics.FillEllipse($DarkBrush, 8, 21, 4, 4)
    $Graphics.FillRectangle($DarkBrush, 16, 8, 8, 2)
    $Graphics.FillRectangle($DarkBrush, 16, 22, 8, 2)
    $Handle = $Bitmap.GetHicon()
    $Icon = [Drawing.Icon]::FromHandle($Handle).Clone()
    [NexusIconHandle]::DestroyIcon($Handle) | Out-Null
    $Graphics.Dispose(); $Brush.Dispose(); $DarkBrush.Dispose(); $Bitmap.Dispose()
    return $Icon
}
$Colors = @{
    green = [Drawing.Color]::FromArgb(63, 201, 126)
    orange = [Drawing.Color]::FromArgb(244, 174, 64)
    red = [Drawing.Color]::FromArgb(240, 96, 101)
}
$Icons = @{}
foreach ($Name in $Colors.Keys) { $Icons[$Name] = New-ServerIcon $Colors[$Name] }
$Form = New-Object Windows.Forms.Form
$Form.Text = "Nexus — stav servera :$Port"
$Form.ClientSize = New-Object Drawing.Size(440, 435)
$Form.FormBorderStyle = 'FixedSingle'
$Form.MaximizeBox = $false
$Form.ShowInTaskbar = $true
$Form.StartPosition = 'Manual'
$Form.BackColor = [Drawing.Color]::FromArgb(29, 31, 36)
$Form.ForeColor = [Drawing.Color]::FromArgb(235, 237, 242)
$Form.Font = New-Object Drawing.Font('Segoe UI', 10)
$Form.Icon = $Icons.red
$script:Quitting = $false
$script:Snapshot = $null
$script:StatusJob = $null
$script:CommandJob = $null
$script:PendingCommand = ''
$script:NextCheck = [DateTime]::MinValue
$script:Diagnostic = ''
$script:ActionMessage = ''
$script:ActionMessageUntil = [DateTime]::MinValue
$script:AwaitingPhase = ''

function Add-Text([string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height) {
    $Label = New-Object Windows.Forms.Label
    $Label.Text = $Text
    $Label.Location = New-Object Drawing.Point($X, $Y)
    $Label.Size = New-Object Drawing.Size($Width, $Height)
    $Form.Controls.Add($Label)
    return $Label
}
$Title = Add-Text 'NEXUS' 20 18 100 30
$Title.Font = New-Object Drawing.Font('Segoe UI', 14, [Drawing.FontStyle]::Bold)
$StateLabel = Add-Text 'Overujem stav…' 190 23 230 27
$StateLabel.TextAlign = 'TopRight'
$LastReply = Add-Text 'Posledná odpoveď: —' 20 60 400 25
$Activity = Add-Text 'Posledná zaznamenaná aktivita: —' 20 105 400 45
$Progress = Add-Text 'Čas aktivity: —' 20 150 400 24
$LogLabel = Add-Text 'Posledné udalosti' 20 191 400 22
$LogBox = New-Object Windows.Forms.TextBox
$LogBox.Location = New-Object Drawing.Point(20, 216)
$LogBox.Size = New-Object Drawing.Size(400, 65)
$LogBox.Multiline = $true
$LogBox.ReadOnly = $true
$LogBox.BorderStyle = 'None'
$LogBox.BackColor = [Drawing.Color]::FromArgb(39, 42, 49)
$LogBox.ForeColor = $Form.ForeColor
$LogBox.Font = New-Object Drawing.Font('Consolas', 9)
$LogBox.ScrollBars = 'Vertical'
$Form.Controls.Add($LogBox)
$Advice = Add-Text 'Prebieha kontrola servera.' 20 297 400 50
$Detail = Add-Text "127.0.0.1:$Port · $Mode" 20 404 400 22
$Detail.ForeColor = [Drawing.Color]::FromArgb(164, 171, 185)

function Add-Button([string]$Text, [int]$X, [int]$Width, [scriptblock]$Click) {
    $Button = New-Object Windows.Forms.Button
    $Button.Text = $Text
    $Button.Location = New-Object Drawing.Point($X, 356)
    $Button.Size = New-Object Drawing.Size($Width, 34)
    $Button.FlatStyle = 'Flat'
    $Button.BackColor = [Drawing.Color]::FromArgb(48, 53, 63)
    $Button.ForeColor = $Form.ForeColor
    $Button.Add_Click($Click)
    $Form.Controls.Add($Button)
    return $Button
}
function Open-Nexus { Start-Process "http://127.0.0.1:$Port" }
$OpenButton = Add-Button 'Otvoriť Nexus' 20 120 { Open-Nexus }
$ActionButton = Add-Button 'Zapnúť' 148 110 { if ($script:Snapshot.managed) { Begin-Command 'restart' } else { Begin-Command 'start' } }
$CopyButton = Add-Button 'Diagnostika' 266 154 {
    if ($script:Diagnostic) {
        [Windows.Forms.Clipboard]::SetText($script:Diagnostic)
        $script:ActionMessage = 'Očistená diagnostika s promptom bola skopírovaná.'
        $script:ActionMessageUntil = [DateTime]::UtcNow.AddSeconds(8)
        $Advice.Text = $script:ActionMessage
    }
}
$Tray = New-Object Windows.Forms.NotifyIcon
$Tray.Icon = $Icons.red
$Tray.Text = 'Nexus: overujem stav'
$Menu = New-Object Windows.Forms.ContextMenuStrip
function Add-Menu([string]$Text, [scriptblock]$Click) {
    $Item = New-Object Windows.Forms.ToolStripMenuItem($Text)
    $Item.Add_Click($Click)
    [void]$Menu.Items.Add($Item)
    return $Item
}
$OpenMenu = Add-Menu 'Otvoriť Nexus' { Open-Nexus }
[void]$Menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$StartMenu = Add-Menu 'Zapnúť' { Begin-Command 'start' }
$StopMenu = Add-Menu 'Vypnúť' { Begin-Command 'stop' }
$RestartMenu = Add-Menu 'Reštartovať' { Begin-Command 'restart' }
[void]$Menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$LogsMenu = Add-Menu 'Zobraziť logy' { Start-Process explorer.exe -ArgumentList ('"' + $LogDir + '"') }
$CopyMenu = Add-Menu 'Kopírovať diagnostiku' { if ($script:Diagnostic) { [Windows.Forms.Clipboard]::SetText($script:Diagnostic) } }
$StartupMenu = Add-Menu 'Spúšťať ikonku po prihlásení' {
    try { Set-TrayStartup (-not $StartupMenu.Checked); $StartupMenu.Checked = $Settings.startup }
    catch { [Windows.Forms.MessageBox]::Show($Form, $_.Exception.Message, 'Nexus — automatické spúšťanie') | Out-Null }
}
[void]$Menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$QuitMenu = Add-Menu 'Ukončiť ikonku (server zostane bežať)' {
    $script:Quitting = $true
    $Form.Close()
    [Windows.Forms.Application]::ExitThread()
}
$Tray.ContextMenuStrip = $Menu
$Form.ContextMenuStrip = $Menu
$MenuButton = New-Object Windows.Forms.Button
$MenuButton.Text = 'Menu'
$MenuButton.Location = New-Object Drawing.Point(128, 18)
$MenuButton.Size = New-Object Drawing.Size(54, 29)
$MenuButton.FlatStyle = 'Flat'
$MenuButton.BackColor = [Drawing.Color]::FromArgb(48, 53, 63)
$MenuButton.ForeColor = $Form.ForeColor
$MenuButton.Add_Click({ $Menu.Show($MenuButton, (New-Object Drawing.Point(0, $MenuButton.Height))) })
$Form.Controls.Add($MenuButton)
function Show-NexusPanel {
    $Area = [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).WorkingArea
    $Form.Location = New-Object Drawing.Point(($Area.Right - $Form.Width - 12), ($Area.Bottom - $Form.Height - 12))
    # A hidden launcher supplies SW_HIDE for the first native ShowWindow call.
    # Explicitly toggle once so opening the panel also works on that first click.
    $Form.Show(); $Form.Hide(); $Form.Show(); $Form.Activate()
}
$Tray.Add_MouseClick({ if ($_.Button -eq [Windows.Forms.MouseButtons]::Left) { Show-NexusPanel } })
$Form.Add_FormClosing({ if (-not $script:Quitting) { $_.Cancel = $true; $Form.Hide() } })
$Form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $Form.Hide() } })
$Form.KeyPreview = $true

function New-HelperJob([string]$Command, [bool]$Force = $false) {
    $Job = [PowerShell]::Create()
    [void]$Job.AddScript({
        param($PythonPath, $HelperPath, $CommandName, $ServerPort, $ServerMode, $ForceStop)
        $Info = New-Object Diagnostics.ProcessStartInfo
        $Info.FileName = $PythonPath
        $Info.Arguments = '"' + $HelperPath + '" ' + $CommandName + ' --port ' + $ServerPort + ' --mode ' + $ServerMode
        if ($ForceStop) { $Info.Arguments += ' --force' }
        $Info.UseShellExecute = $false
        $Info.CreateNoWindow = $true
        $Info.RedirectStandardOutput = $true
        $Info.RedirectStandardError = $true
        $Info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
        $Process = New-Object Diagnostics.Process
        $Process.StartInfo = $Info
        try {
            [void]$Process.Start()
            $ErrorRead = $Process.StandardError.ReadToEndAsync()
            $Output = $Process.StandardOutput.ReadToEnd()
            $Process.WaitForExit()
            $Errors = $ErrorRead.Result
            if (-not $Output.Trim()) { throw 'Ovládanie nevrátilo stav. Skontroluj Python prostredie a logy.' }
            $Output.Trim()
        } finally { $Process.Dispose() }
    }).AddArgument($Python).AddArgument($Helper).AddArgument($Command).AddArgument($Port).AddArgument($Mode).AddArgument($Force)
    return @{ shell = $Job; handle = $Job.BeginInvoke() }
}
function Complete-HelperJob($Job) {
    try {
        $Output = $Job.shell.EndInvoke($Job.handle)
        if ($Job.shell.HadErrors) { throw 'Ovládanie zlyhalo. Skontroluj Python prostredie a logy.' }
        return ($Output -join "`n" | ConvertFrom-Json)
    } finally { $Job.shell.Dispose() }
}
function Begin-Command([string]$Command, [bool]$Force = $false) {
    if ($script:CommandJob) { return }
    $script:PendingCommand = $Command
    $script:ActionMessage = ''
    $script:AwaitingPhase = if ($Command -eq 'start') { 'Štartuje' } elseif ($Command -eq 'stop') { 'Zastavuje sa' } else { 'Reštartuje sa' }
    $Tray.Icon = $Icons.orange
    $Form.Icon = $Icons.orange
    $StateLabel.ForeColor = $Colors.orange
    $StateLabel.Text = $script:AwaitingPhase
    $Advice.Text = 'Počkaj na dokončenie príkazu.'
    $script:CommandJob = New-HelperJob $Command $Force
    Update-Actions
}
function Update-Actions {
    $Ready = $null -ne $script:Snapshot -and -not $script:CommandJob
    $StartMenu.Enabled = $Ready -and -not $script:Snapshot.managed -and -not $script:Snapshot.conflict
    $StopMenu.Enabled = $Ready -and $script:Snapshot.managed
    $RestartMenu.Enabled = $Ready -and $script:Snapshot.managed
    $OpenMenu.Enabled = $Ready -and $script:Snapshot.live_ok
    $OpenButton.Enabled = $OpenMenu.Enabled
    $ActionButton.Enabled = $StartMenu.Enabled -or $RestartMenu.Enabled
    $ActionButton.Text = if ($script:Snapshot.managed) { 'Reštartovať' } else { 'Zapnúť' }
    $CopyButton.Enabled = $null -ne $script:Snapshot
    $QuitMenu.Enabled = -not $script:CommandJob
}
function Age-Text($Timestamp) {
    if (-not $Timestamp) { return '—' }
    $Age = [Math]::Max(0, [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [double]$Timestamp))
    if ($Age -lt 60) { return "pred $Age s" }
    return "pred $([int][Math]::Floor($Age / 60)) min"
}
function Render-Status {
    $Value = $script:Snapshot
    if (-not $Value) { return }
    if ($script:ActionMessageUntil -ne [DateTime]::MinValue -and [DateTime]::UtcNow -ge $script:ActionMessageUntil) {
        $script:ActionMessage = ''
        $script:ActionMessageUntil = [DateTime]::MinValue
    }
    $LastReply.Text = 'Posledná odpoveď: ' + (Age-Text $Value.last_success)
    $Events = @($Value.events)
    $Latest = $Events | Select-Object -Last 1
    $Activity.Text = 'Posledná zaznamenaná aktivita: ' + $(if ($Latest) { $Latest.message } else { 'bez záznamu' })
    $Progress.Text = 'Čas aktivity: ' + (Age-Text $Latest.ts) + $(if ($Value.stale) { ' · neaktuálne' } else { '' })
    $LogLabel.Text = 'Posledné udalosti' + $(if ($Value.stale) { ' · neaktuálne' } else { '' })
    $Lines = @($Events | ForEach-Object {
        $Stamp = if ($_.ts) { [DateTimeOffset]::FromUnixTimeSeconds([long]$_.ts).ToLocalTime().ToString('HH:mm:ss') } else { 'bez času' }
        "$Stamp  $($_.message)"
    })
    $LogBox.Text = $Lines -join "`r`n"
    $Detail.Text = "127.0.0.1:$Port · $($Value.mode) · obnovy: $($Value.restart_count)" + $(if ($Value.legacy) { ' · starší dohľad' } else { '' })
    if (-not $script:CommandJob) {
        $Tray.Icon = $Icons[$Value.color]
        $Form.Icon = $Icons[$Value.color]
        $StateLabel.Text = $Value.label
        $StateLabel.ForeColor = $Colors[$Value.color]
        $Advice.Text = if ($script:ActionMessage) { $script:ActionMessage } else { $Value.advice }
        $Tip = "Nexus: $($Value.label) | odpoveď $(Age-Text $Value.last_success)"
        $Tray.Text = $Tip.Substring(0, [Math]::Min(63, $Tip.Length))
    }
    $script:Diagnostic = @"
Pomôž mi diagnostikovať lokálny Nexus. Vysvetli pravdepodobnú príčinu a navrhni ďalší bezpečný krok.
Stav: $($Value.label); port: $Port; režim: $($Value.mode); fáza: $($Value.phase)
Posledná odpoveď: $(Age-Text $Value.last_success); obnovy: $($Value.restart_count)
Posledná chyba: $($Value.last_error)
Udalosti $(if ($Value.stale) { '(neaktuálne)' }):
$($Lines -join "`r`n")
"@
    Update-Actions
}
$Timer = New-Object Windows.Forms.Timer
$Timer.Interval = 250
$Timer.Add_Tick({
    try {
        if ($script:CommandJob -and $script:CommandJob.handle.IsCompleted) {
            $Job = $script:CommandJob
            $script:CommandJob = $null
            $Result = Complete-HelperJob $Job
            $script:ActionMessage = if ($Result.ok) { '' } else { $Result.message }
            $script:ActionMessageUntil = [DateTime]::MinValue
            $script:NextCheck = [DateTime]::MinValue
            if ($Result.needs_force) {
                Show-NexusPanel
                $Answer = [Windows.Forms.MessageBox]::Show($Form, ($Result.message + "`r`n`r`nVynútiť " + $(if ($script:PendingCommand -eq 'restart') { 'reštart' } else { 'zastavenie' }) + '?'), 'Nexus — vynútené ukončenie', 'YesNo', 'Warning', 'Button2')
                if ($Answer -eq 'Yes') { Begin-Command $script:PendingCommand $true }
            }
        }
        if ($script:StatusJob -and $script:StatusJob.handle.IsCompleted) {
            $Job = $script:StatusJob
            $script:StatusJob = $null
            $script:Snapshot = Complete-HelperJob $Job
            Render-Status
        }
        if (-not $script:StatusJob -and [DateTime]::UtcNow -ge $script:NextCheck) {
            $script:StatusJob = New-HelperJob 'status'
            $script:NextCheck = [DateTime]::UtcNow.AddSeconds(5)
        }
    } catch {
        $Tray.Icon = $Icons.orange
        $StateLabel.Text = 'Kontrola zlyhala'
        $StateLabel.ForeColor = $Colors.orange
        $Advice.Text = 'Kontrola zlyhala. Skontroluj Python prostredie a logy ikonky.'
        Add-Content -LiteralPath (Join-Path $LogDir "tray-$Port.err.log") -Value $_.Exception.Message
    }
})
Update-Actions
try {
    if (-not $NoStartup) {
        try { Set-TrayStartup $Settings.startup } catch { $script:ActionMessage = 'Automatické spúšťanie sa nepodarilo nastaviť; použi menu ikonky.' }
    }
    $StartupMenu.Checked = Test-Path -LiteralPath $StartupLink
    $Tray.Visible = $true
    $Timer.Start()
    if ($ShowPanel) { Show-NexusPanel }
    [Windows.Forms.Application]::Run()
} finally {
    $Timer.Stop(); $Timer.Dispose()
    $Tray.Visible = $false
    $Tray.Dispose(); $Menu.Dispose(); $Form.Dispose()
    foreach ($Job in @($script:StatusJob, $script:CommandJob)) {
        if ($Job) { $Job.shell.Stop(); $Job.shell.Dispose() }
    }
    foreach ($Icon in $Icons.Values) { $Icon.Dispose() }
    $Mutex.ReleaseMutex(); $Mutex.Dispose()
}
