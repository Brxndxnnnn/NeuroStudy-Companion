using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;

namespace NeuuroBridge.Wpf
{
    public partial class App : Application
    {
        /// <summary>Raised (on the UI thread) when an unexpected error was caught and the app kept
        /// running, so the main window can show it in the session log.</summary>
        internal static event Action<string> RecoveredError;

        private DateTime _lastRecoveredUtc;
        private string _lastRecoveredMessage;

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            InstallCrashHandlers();
            BridgeLogs.Prune();

            // First-run enrollment: no machine config store → activation dialog before
            // anything else. Declining (closing it) exits — the bridge is useless without
            // credentials. Dev boxes with a repo .env are unaffected once activated is
            // present OR skipped entirely via ACTIVATION_OPTIONAL=true (no store, no
            // dialog, .env fallback as before).
            if (!ConfigStore.Exists &&
                !string.Equals(EnvConfig.FindDotEnvValue("ACTIVATION_OPTIONAL"), "true",
                               System.StringComparison.OrdinalIgnoreCase))
            {
                var activated = new ActivationWindow().ShowDialog() == true;
                if (!activated)
                {
                    Shutdown();
                    return;
                }
            }

            var main = new MainWindow();
            MainWindow = main;
            ShutdownMode = ShutdownMode.OnMainWindowClose;
            main.Show();

            // Never offer an update (which restarts the app) while a band is connected or EEG is
            // still uploading: it waits until the bridge is idle.
            UpdateService.CheckInBackground(() => main.IsBusy);
        }

        // An exception in any event handler used to take the whole bridge down mid-recording — every
        // SDK callback runs on the UI thread, so one bad frame was enough. UI-thread exceptions are now
        // logged and the app keeps going; the recording, DB upload and reconnect logic live on their
        // own state and timers and carry on. Exceptions on other threads cannot be recovered in .NET
        // Framework, but they are written to crash.txt before the process ends so they can be traced.
        private void InstallCrashHandlers()
        {
            DispatcherUnhandledException += (s, args) =>
            {
                BridgeLogs.WriteCrash("UI thread (recovered)", args.Exception);
                args.Handled = true;
                ReportRecovered(args.Exception);
            };
            AppDomain.CurrentDomain.UnhandledException += (s, args) =>
                BridgeLogs.WriteCrash(args.IsTerminating ? "Background thread (fatal)" : "Background thread",
                                      args.ExceptionObject as Exception ?? new Exception(args.ExceptionObject?.ToString()));
            TaskScheduler.UnobservedTaskException += (s, args) =>
            {
                BridgeLogs.WriteCrash("Background task (recovered)", args.Exception);
                args.SetObserved();
            };
        }

        // The same exception can fire on every frame; report it at most every 10 s.
        private void ReportRecovered(Exception ex)
        {
            var now = DateTime.UtcNow;
            if (ex.Message == _lastRecoveredMessage && (now - _lastRecoveredUtc).TotalSeconds < 10) return;
            _lastRecoveredUtc = now;
            _lastRecoveredMessage = ex.Message;
            RecoveredError?.Invoke($"ERROR (recovered, details in {System.IO.Path.Combine(BridgeLogs.Directory, "crash.txt")}): " +
                                   $"{ex.GetType().Name}: {ex.Message}");
        }
    }
}
