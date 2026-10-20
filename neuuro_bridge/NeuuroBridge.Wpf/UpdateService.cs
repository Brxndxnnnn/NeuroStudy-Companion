using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using Velopack;
using Velopack.Sources;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// On-launch update check against the Velopack feed. Fire-and-forget: a missing,
    /// unreachable, or placeholder feed must never affect normal use — an offline
    /// clinic still records sessions.
    /// </summary>
    internal static class UpdateService
    {
        // How often to look again while the bridge is busy before offering the update.
        private static readonly TimeSpan BusyRecheck = TimeSpan.FromSeconds(30);

        /// <param name="isBusy">True while a band is connected, a session is recording, or EEG is
        /// still uploading. The prompt (and the restart it leads to) waits until this is false, so an
        /// update can never interrupt a session — the technician used to have to remember to say No.</param>
        public static async void CheckInBackground(Func<bool> isBusy)
        {
            try
            {
                if (!BridgeSettings.IsFeedConfigured) return;

                var feed = BridgeSettings.UpdateFeedUrl;
                IUpdateSource source = feed.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                    ? (IUpdateSource)new SimpleWebSource(new Uri(feed))
                    : new SimpleFileSource(new DirectoryInfo(feed));

                var mgr = new UpdateManager(source);
                if (!mgr.IsInstalled) return; // running from bin\ in dev — nothing to update

                var info = await mgr.CheckForUpdatesAsync();
                if (info == null) return;

                // Download in the background now (no restart involved), so the update is ready the
                // moment the bridge goes idle.
                await mgr.DownloadUpdatesAsync(info);

                while (isBusy != null && isBusy())
                    await Task.Delay(BusyRecheck);   // resumes on the UI thread, where isBusy is safe to call
                if (Application.Current?.MainWindow == null) return;   // app closed meanwhile

                var ask = MessageBox.Show(
                    $"NeuuroBridge {info.TargetFullRelease.Version} is ready to install " +
                    $"(installed: {mgr.CurrentVersion}).\n\n" +
                    "Install now? The app will restart. Choose No to keep working; the update " +
                    "will be offered again next launch.",
                    "NeuuroBridge update", MessageBoxButton.YesNo, MessageBoxImage.Information);
                if (ask != MessageBoxResult.Yes) return;

                // The technician may have connected a band while the dialog was open.
                if (isBusy != null && isBusy())
                {
                    MessageBox.Show("A band is connected now, so the update will be installed next time the bridge starts.",
                        "NeuuroBridge update", MessageBoxButton.OK, MessageBoxImage.Information);
                    return;
                }
                mgr.ApplyUpdatesAndRestart(info);
            }
            catch (Exception)
            {
                // Never let update plumbing break the bridge.
            }
        }
    }
}
