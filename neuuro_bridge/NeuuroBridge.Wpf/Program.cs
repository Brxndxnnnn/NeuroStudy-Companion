using System;
using Velopack;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// Explicit entry point so Velopack's install/update hooks run before WPF spins up
    /// (Velopack relaunches the exe with --veloapp-* args during install/update; Run()
    /// handles them and exits). Wired via &lt;StartupObject&gt; in the csproj.
    /// </summary>
    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            VelopackApp.Build().Run();
            var app = new App();
            app.InitializeComponent();
            app.Run();
        }
    }
}
