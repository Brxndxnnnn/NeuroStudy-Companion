using System;
using System.IO;
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
        public static async void CheckInBackground()
        {
            try
            {
                if (BridgeSettings.IsPlaceholderFeed) return;

                var feed = BridgeSettings.UpdateFeedUrl;
                IUpdateSource source = feed.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                    ? (IUpdateSource)new SimpleWebSource(new Uri(feed))
                    : new SimpleFileSource(new DirectoryInfo(feed));

                var mgr = new UpdateManager(source);
                if (!mgr.IsInstalled) return; // running from bin\ in dev — nothing to update

                var info = await mgr.CheckForUpdatesAsync();
                if (info == null) return;

                var ask = MessageBox.Show(
                    $"NeuuroBridge {info.TargetFullRelease.Version} is available " +
                    $"(installed: {mgr.CurrentVersion}).\n\n" +
                    "Install now? The app will restart — if a session is running, choose No " +
                    "and the update will be offered again next launch.",
                    "NeuuroBridge update", MessageBoxButton.YesNo, MessageBoxImage.Information);
                if (ask != MessageBoxResult.Yes) return;

                await mgr.DownloadUpdatesAsync(info);
                mgr.ApplyUpdatesAndRestart(info);
            }
            catch (Exception)
            {
                // Never let update plumbing break the bridge.
            }
        }
    }
}
