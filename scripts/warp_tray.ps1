param([switch]$ShowPanel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$cli = Join-Path $env:ProgramFiles 'Cloudflare\Cloudflare WARP\warp-cli.exe'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'START_WARP_PANEL.vbs'
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nexus WARP status.lnk'
$mutex = New-Object Threading.Mutex($false, 'Local\NexusWarpStatusPanel')
$showEvent = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, 'Local\NexusWarpStatusShow')
if (-not $mutex.WaitOne(0)) {
    if ($ShowPanel) { $showEvent.Set() | Out-Null }
    $showEvent.Dispose(); $mutex.Dispose(); exit
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WarpTrayNative {
 [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
}
'@
$colors = @{ green=[Drawing.Color]::FromArgb(45,210,133); red=[Drawing.Color]::FromArgb(244,98,102); amber=[Drawing.Color]::FromArgb(242,177,66) }
function New-WarpIcon($color) {
    $bitmap = New-Object Drawing.Bitmap(32,32)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = 'AntiAlias'
    $b = New-Object Drawing.SolidBrush($color)
    $g.FillEllipse($b, 1, 1, 30, 30)
    $font = New-Object Drawing.Font('Segoe UI', 17, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $ink = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(18,25,30))
    $g.DrawString('W', $font, $ink, 5, 5)
    $handle = $bitmap.GetHicon(); $icon = [Drawing.Icon]::FromHandle($handle).Clone()
    [WarpTrayNative]::DestroyIcon($handle) | Out-Null
    $ink.Dispose(); $font.Dispose(); $b.Dispose(); $g.Dispose(); $bitmap.Dispose()
    return $icon
}
$icons = @{}; foreach ($key in $colors.Keys) { $icons[$key] = New-WarpIcon $colors[$key] }
$form = New-Object Windows.Forms.Form
$form.Text = 'WARP · stav pripojenia'; $form.ClientSize = New-Object Drawing.Size(400, 330)
$form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false; $form.StartPosition = 'Manual'
$form.BackColor = [Drawing.Color]::FromArgb(23,27,36); $form.ForeColor = [Drawing.Color]::FromArgb(235,239,245)
$form.Font = New-Object Drawing.Font('Segoe UI',10); $form.ShowInTaskbar = $true
function Label([string]$text,[int]$y,[int]$h) {
    $l=New-Object Windows.Forms.Label; $l.Text=$text; $l.Location=New-Object Drawing.Point(22,$y)
    $l.Size=New-Object Drawing.Size(355,$h); $form.Controls.Add($l); return $l
}
$heading=Label 'CLOUDFLARE WARP' 18 29; $heading.Font=New-Object Drawing.Font('Segoe UI',14,[Drawing.FontStyle]::Bold)
$state=Label 'Overujem stav…' 57 32; $state.Font=New-Object Drawing.Font('Segoe UI',12,[Drawing.FontStyle]::Bold)
$ip=Label 'Verejná IP: overujem…' 102 26
$trace=Label 'Overenie trasy: čakám na odpoveď' 132 36
$checked=Label 'Posledná kontrola: —' 172 25; $checked.ForeColor=[Drawing.Color]::FromArgb(165,174,190)
$message=Label '' 201 35; $message.ForeColor=[Drawing.Color]::FromArgb(242,177,66)
function Button([string]$text,[int]$x,[int]$width) {
    $b=New-Object Windows.Forms.Button; $b.Text=$text; $b.Location=New-Object Drawing.Point($x,246)
    $b.Size=New-Object Drawing.Size($width,39); $b.FlatStyle='Flat'; $b.BackColor=[Drawing.Color]::FromArgb(46,54,67)
    $b.ForeColor=$form.ForeColor; $form.Controls.Add($b); return $b
}
$toggle=Button 'Čakám…' 22 170; $refresh=Button 'Overiť teraz' 202 175
$hint=Label 'Ikonka: zelená = pripojené · červená = vypnuté' 300 22
$hint.Font=New-Object Drawing.Font('Segoe UI',8); $hint.ForeColor=[Drawing.Color]::FromArgb(165,174,190)
$tray=New-Object Windows.Forms.NotifyIcon; $tray.Icon=$icons.amber; $tray.Text='WARP: overujem'; $tray.Visible=$true
$menu=New-Object Windows.Forms.ContextMenuStrip
$open=$menu.Items.Add('Otvoriť panel'); $open.Add_Click({ Show-Panel })
$verify=$menu.Items.Add('Overiť stav'); $verify.Add_Click({ Start-Check })
$startup=$menu.Items.Add('Spúšťať po prihlásení'); $startup.CheckOnClick=$false
$startup.Add_Click({
 try {
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link }
  else { $s=New-Object -ComObject WScript.Shell; $sc=$s.CreateShortcut($link); $sc.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe'; $sc.Arguments='"'+$launcher+'"'; $sc.WorkingDirectory=$root; $sc.Save(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($s) | Out-Null }
  $startup.Checked=Test-Path -LiteralPath $link
 } catch { $message.Text='Nepodarilo sa zmeniť automatické spúšťanie.' }
})
$quit=$menu.Items.Add('Ukončiť ikonku'); $quit.Add_Click({ $script:quitting=$true; $form.Close(); [Windows.Forms.Application]::ExitThread() })
$tray.ContextMenuStrip=$menu; $startup.Checked=Test-Path -LiteralPath $link
$script:quitting=$false; $script:checkJob=$null; $script:actionJob=$null; $script:lastStatus=''; $script:nextCheck=[datetime]::MinValue
function Show-Panel {
 $area=[Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).WorkingArea
 $form.Location=New-Object Drawing.Point(($area.Right-$form.Width-12),($area.Bottom-$form.Height-12))
 $form.Show(); $form.Hide(); $form.Show(); $form.Activate()
}
$tray.Add_MouseClick({ if ($_.Button -eq [Windows.Forms.MouseButtons]::Left) { Show-Panel; Start-Check } })
$form.Add_FormClosing({ if (-not $script:quitting) { $_.Cancel=$true; $form.Hide() } })
function Start-Check {
 if ($script:checkJob -or $script:actionJob) { return }
 $script:nextCheck=[datetime]::UtcNow.AddSeconds(20)
 $script:checkJob=Start-Job -ArgumentList $cli -ScriptBlock {
  param($exe)
  $result=@{ status='Unknown'; reason=''; ip=''; warp=''; error=''; time=(Get-Date).ToString('HH:mm:ss') }
  try { $j=(& $exe -j status 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw 'WARP klient neodpovedá' }; $o=$j|ConvertFrom-Json; $result.status=$o.status; $result.reason=$o.reason } catch { $result.error='Stav klienta nie je dostupný.' }
  try {
   $r=Invoke-WebRequest 'https://www.cloudflare.com/cdn-cgi/trace' -UseBasicParsing -TimeoutSec 8
   foreach ($line in ($r.Content -split "`n")) { if ($line -match '^ip=(.+)$') { $result.ip=$Matches[1].Trim() }; if ($line -match '^warp=(.+)$') { $result.warp=$Matches[1].Trim() } }
  } catch { }
  [pscustomobject]$result
 }
}
$refresh.Add_Click({ $message.Text=''; Start-Check })
$toggle.Add_Click({
 if ($script:actionJob -or $script:checkJob) { return }
 if ($script:lastStatus -eq 'Connected') { $action='disconnect'; $message.Text='Odpájam…' }
 elseif ($script:lastStatus -eq 'Disconnected') { $action='connect'; $message.Text='Pripájam…' }
 else { $message.Text='Najprv over aktuálny stav.'; Start-Check; return }
 $toggle.Enabled=$false
 $script:actionJob=Start-Job -ArgumentList $cli,$action -ScriptBlock { param($exe,$verb); $out=(& $exe $verb 2>&1 | Out-String); [pscustomobject]@{ ok=($LASTEXITCODE -eq 0); text=$out.Trim() } }
})
$timer=New-Object Windows.Forms.Timer; $timer.Interval=500
$timer.Add_Tick({
 try {
  if ($showEvent.WaitOne(0)) { Show-Panel; Start-Check }
  if ($script:actionJob -and $script:actionJob.State -ne 'Running') {
   $a=Receive-Job $script:actionJob -ErrorAction SilentlyContinue; Remove-Job $script:actionJob -Force; $script:actionJob=$null
   if (-not $a -or -not $a.ok) { $message.Text='Príkaz sa nepodaril. Skontroluj nastavenia WARP.' } else { $message.Text='Príkaz odoslaný; overujem skutočný stav.' }
   $script:lastStatus=''; $script:nextCheck=[datetime]::MinValue
  }
  if ($script:checkJob -and $script:checkJob.State -ne 'Running') {
   $r=Receive-Job $script:checkJob -ErrorAction SilentlyContinue; Remove-Job $script:checkJob -Force; $script:checkJob=$null
   $color='amber'; $script:lastStatus=if ($r) { [string]$r.status } else { 'Unknown' }
   if ($script:lastStatus -eq 'Connected') { $state.Text='●  Pripojené'; $toggle.Text='Odpojiť WARP'; $color='green' }
   elseif ($script:lastStatus -eq 'Disconnected') { $state.Text='●  Vypnuté'; $toggle.Text='Pripojiť WARP'; $color='red' }
   else { $state.Text='●  Stav nie je overený'; $toggle.Text='Stav nie je známy' }
   $state.ForeColor=$colors[$color]; $tray.Icon=$icons[$color]; $form.Icon=$icons[$color]
   $tray.Text=if ($color -eq 'green') {'WARP: pripojené'} elseif ($color -eq 'red') {'WARP: vypnuté'} else {'WARP: stav neoverený'}
   $toggle.Enabled=($color -ne 'amber')
   $ip.Text=if ($r -and $r.ip) { 'Verejná IP: '+$r.ip } else { 'Verejná IP: nedostupná' }
   $trace.Text=if (-not $r -or -not $r.warp) { 'Overenie trasy: nedostupné' } elseif ($r.warp -eq 'on') { 'Overenie trasy: Cloudflare hlási WARP' } elseif ($r.warp -eq 'plus') { 'Overenie trasy: Cloudflare hlási WARP+' } else { 'Overenie trasy: Cloudflare hlási '+$r.warp }
   if ($r -and $r.warp -and (($color -eq 'green' -and $r.warp -eq 'off') -or ($color -eq 'red' -and $r.warp -ne 'off'))) { $trace.Text += ' · nesúlad so stavom klienta' }
   $checked.Text=if ($r) { 'Posledná kontrola: '+$r.time } else { 'Posledná kontrola zlyhala' }
   if ($r -and $r.error) { $message.Text=$r.error } elseif ($message.Text -eq 'Príkaz odoslaný; overujem skutočný stav.') { $message.Text='' }
  }
  if (-not $script:checkJob -and -not $script:actionJob -and [datetime]::UtcNow -ge $script:nextCheck) { Start-Check }
 } catch { $state.Text='●  Kontrola zlyhala'; $state.ForeColor=$colors.amber; $tray.Icon=$icons.amber; $toggle.Enabled=$false; $script:nextCheck=[datetime]::UtcNow.AddSeconds(20) }
})
try { $timer.Start(); Start-Check; if ($ShowPanel) { Show-Panel }; [Windows.Forms.Application]::Run() }
finally { $timer.Stop(); $timer.Dispose(); foreach($j in @($script:checkJob,$script:actionJob)) { if($j) { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue } }; $tray.Visible=$false; $tray.Dispose(); $menu.Dispose(); $form.Dispose(); foreach($i in $icons.Values){$i.Dispose()}; $showEvent.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }
