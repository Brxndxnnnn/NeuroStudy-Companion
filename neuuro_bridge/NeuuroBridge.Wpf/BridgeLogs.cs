using System;
using System.IO;
using System.Linq;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// Where the bridge's own logs live, plus a crash log that works before (and after) the main
    /// window exists.
    ///
    /// The logs used to go to a "logs" folder next to the exe. On an installed bridge that folder
    /// is Velopack's "current" directory, which every update replaces, so each update deleted the
    /// logs from the sessions we would most want to investigate. They now live in
    /// %LocalAppData%\NeuuroBridge\logs (beside Velopack's folders, not inside them), and files older
    /// than <see cref="KeepDays"/> are pruned at startup so a clinic PC doesn't fill up over the years.
    ///
    /// The vendor SDK still writes its own numbered logs next to the exe; that path is inside the
    /// closed-source SDK and cannot be moved from here.
    /// </summary>
    internal static class BridgeLogs
    {
        private const int KeepDays = 30;
        private static readonly object CrashLock = new object();

        public static string Directory { get; } = Resolve();

        private static string Resolve()
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NeuuroBridge", "logs");
                System.IO.Directory.CreateDirectory(dir);
                return dir;
            }
            catch
            {
                // Fall back to the old location rather than having no log at all.
                string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
                try { System.IO.Directory.CreateDirectory(dir); } catch { /* ignore */ }
                return dir;
            }
        }

        /// <summary>Deletes bridge/crash logs older than <see cref="KeepDays"/>. Best-effort.</summary>
        public static void Prune()
        {
            try
            {
                var cutoff = DateTime.Now.AddDays(-KeepDays);
                foreach (var f in new DirectoryInfo(Directory).GetFiles("*.txt")
                             .Where(f => f.LastWriteTime < cutoff))
                {
                    try { f.Delete(); } catch { /* in use or locked: try again next start */ }
                }
            }
            catch { /* never let housekeeping stop the bridge */ }
        }

        /// <summary>Appends an unexpected exception to crash.txt. Never throws.</summary>
        public static void WriteCrash(string source, Exception ex)
        {
            try
            {
                lock (CrashLock)
                {
                    File.AppendAllText(Path.Combine(Directory, "crash.txt"),
                        $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {source} (bridge v{Core.AppVersionOrUnknown()}){Environment.NewLine}" +
                        $"{ex}{Environment.NewLine}{Environment.NewLine}");
                }
            }
            catch { /* nothing more we can do */ }
        }

        private static class Core
        {
            public static string AppVersionOrUnknown() => BridgeController.AppVersion ?? "unknown";
        }
    }
}
