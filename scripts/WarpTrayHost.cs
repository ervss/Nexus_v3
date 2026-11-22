using System;
using System.Diagnostics;
using System.IO;

// Keep the Windows tray process alive and retain startup failures in the
// existing Nexus log directory.
internal static class WarpTrayHost
{
    [STAThread]
    private static void Main(string[] args)
    {
        string scripts = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        string root = Directory.GetParent(scripts).FullName;
        string dir = Path.Combine(root, "logs", "server");
        Directory.CreateDirectory(dir);
        string log = Path.Combine(dir, "warp-tray-runtime.log");
        try
        {
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            string command = "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(scripts, "warp_tray.ps1") + "\"";
            if (args.Length == 0 || args[0] == "--show-panel") command += " -ShowPanel";
            var start = new ProcessStartInfo(powershell, command) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, WindowStyle = ProcessWindowStyle.Hidden };
            using (var child = new Process { StartInfo = start })
            {
                child.ErrorDataReceived += (sender, e) => { if (e.Data != null) try { File.AppendAllText(log, e.Data + Environment.NewLine); } catch { } };
                child.Start();
                child.BeginErrorReadLine();
                File.AppendAllText(log, DateTime.Now.ToString("s") + " started pid=" + child.Id + Environment.NewLine);
                child.WaitForExit();
                File.AppendAllText(log, DateTime.Now.ToString("s") + " exited code=" + child.ExitCode + Environment.NewLine);
            }
        }
        catch (Exception e) { try { File.AppendAllText(log, DateTime.Now.ToString("s") + " " + e + Environment.NewLine); } catch { } }
    }
}
