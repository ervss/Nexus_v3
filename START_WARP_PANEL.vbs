Option Explicit
Dim sh, fs, root, cmd
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
cmd = """" & root & "\scripts\bin\NexusWarpTray.exe"""
If WScript.Arguments.Count > 0 Then
  cmd = cmd & " --show-panel"
Else
  cmd = cmd & " --silent"
End If
sh.Run cmd, 0, False
