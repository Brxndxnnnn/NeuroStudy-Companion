using System.Windows;

namespace NeuuroBridge.Wpf
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

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

            UpdateService.CheckInBackground();
        }
    }
}
