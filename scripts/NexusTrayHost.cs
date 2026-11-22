// Native Windows GUI host for the PowerShell/WinForms tray. No terminal window.
using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;

internal static class NexusTrayHost
{
    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            string scripts = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
            int port = 8000;
            string mode = "classic";
            bool show = false, noStartup = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--port") port = int.Parse(args[++i]);
                else if (args[i] == "--mode") mode = args[++i];
                else if (args[i] == "--show-panel") show = true;
                else if (args[i] == "--no-startup") noStartup = true;
                else throw new ArgumentException("Unknown argument: " + args[i]);
            }
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            string trayScript = Path.Combine(scripts, "nexus_tray.ps1");
            string arguments = "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + trayScript +
                "\" -Port " + port + " -Mode " + mode;
            if (show) arguments += " -ShowPanel";
            if (noStartup) arguments += " -NoStartup";
            ProcessStartInfo start = new ProcessStartInfo(powershell, arguments);
            start.WorkingDirectory = Directory.GetParent(scripts).FullName;
            start.CreateNoWindow = true;
            start.UseShellExecute = false;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            string projectRoot = Directory.GetParent(scripts).FullName;
            string runtimeLog = Path.Combine(projectRoot, "logs", "server", "tray-launch-runtime.log");
            using (Process tray = Process.Start(start))
            {
                if (tray == null) throw new InvalidOperationException("PowerShell tray sa nepodarilo spustiť.");
                File.AppendAllText(runtimeLog, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " child started pid=" + tray.Id + Environment.NewLine);
                tray.WaitForExit();
                File.AppendAllText(runtimeLog, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " child exited code=" + tray.ExitCode + Environment.NewLine);
                if (tray.ExitCode != 0) throw new InvalidOperationException("PowerShell tray sa ukončil s chybou " + tray.ExitCode + ".");
            }
        }
        catch (Exception error)
        {
            try
            {
                string projectRoot = Directory.GetParent(Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName).FullName;
                string logDirectory = Path.Combine(projectRoot, "logs", "server");
                Directory.CreateDirectory(logDirectory);
                File.AppendAllText(Path.Combine(logDirectory, "tray-launch-runtime.err.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + Environment.NewLine + error + Environment.NewLine + Environment.NewLine);
            }
            catch { }
            MessageBox.Show(error.Message, "Nexus — ikonka sa nespustila", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
