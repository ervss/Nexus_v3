Option Explicit
Dim shell, fso, root, command, port, mode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
port = "8000"
mode = "classic"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
If WScript.Arguments.Count > 1 Then mode = WScript.Arguments(1)
If Not IsNumeric(port) Then WScript.Quit 1
If CLng(port) < 1 Or CLng(port) > 55535 Then WScript.Quit 1
If mode <> "classic" And mode <> "lite" Then WScript.Quit 1
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\build_tray.ps1"" -Launch -Port " & CLng(port) & " -Mode " & mode
shell.Run command, 0, False
