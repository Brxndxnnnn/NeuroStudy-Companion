using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;

namespace NeuuroBridge.Wpf
{
    public partial class MainWindow : Window
    {
        private readonly BridgeController _ctl = new BridgeController();
        private readonly DispatcherTimer _refresh = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        private DispatcherTimer _scanTimer;

        private static readonly Brush Good = (Brush)new BrushConverter().ConvertFromString("#22C55E");
        private static readonly Brush Warn = (Brush)new BrushConverter().ConvertFromString("#F59E0B");
        private static readonly Brush Bad  = (Brush)new BrushConverter().ConvertFromString("#EF4444");
        private static readonly Brush Mut  = (Brush)new BrushConverter().ConvertFromString("#6B7A90");

        public MainWindow()
        {
            InitializeComponent();
            Loaded += OnLoaded;
            Closing += (_, __) => { try { _ctl.Dispose(); } catch { } };
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            // Controller events marshal to whatever thread is current at Initialize() — the UI
            // thread here — but guard with Ui() anyway in case a callback slips in off-thread.
            _ctl.Log += m => Ui(() => AppendLog(m));
            _ctl.Initialized += () => Ui(() => { Log("SDK initialized."); BtnScan.IsEnabled = true; });
            _ctl.DevicesChanged += () => Ui(RefreshDeviceList);
            _ctl.Connected += (addr, id) => Ui(() => OnConnected(addr, id));
            _ctl.Disconnected += addr => Ui(() => OnDisconnected(addr));
            _ctl.AuthChanged += (ok, detail) => Ui(() => OnAuth(ok, detail));
            _ctl.SessionStarted += () => Ui(OnSessionStarted);
            _ctl.SessionStopped += () => Ui(OnSessionStopped);

            _refresh.Tick += (_, __) => RefreshLiveState();
            _refresh.Start();

            string license = EnvConfig.ResolveLicense();
            if (string.IsNullOrWhiteSpace(license))
                Log("WARNING: no NEUURO_LICENSE_KEY in .env — authentication (and raw EEG) will not work.");
            else
                Log("License loaded from .env.");

            Log("Initializing SDK…");
            _ctl.Initialize(license);
        }

        // ── Buttons ──────────────────────────────────────────────────────────
        private void BtnScan_Click(object sender, RoutedEventArgs e)
        {
            CmbDevices.ItemsSource = null;
            BtnScan.IsEnabled = false;
            BtnScan.Content = "Scanning…";
            Log("Scanning for SenzeBands (12s)… make sure the band is ON.");
            if (!_ctl.StartScan())
            {
                Log("ERROR: scan failed to start (is Bluetooth ON?).");
                BtnScan.IsEnabled = true; BtnScan.Content = "Scan (12s)";
                return;
            }
            _scanTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(12) };
            _scanTimer.Tick += (_, __) =>
            {
                _scanTimer.Stop();
                _ctl.StopScan();
                RefreshDeviceList();
                int n = CmbDevices.Items.Count;
                Log(n == 0 ? "No devices found. Make sure the band is on and in range." : $"Scan complete — {n} device(s).");
                BtnScan.IsEnabled = true; BtnScan.Content = "Scan (12s)";
                BtnConnect.IsEnabled = n > 0;
                if (n > 0 && CmbDevices.SelectedIndex < 0) CmbDevices.SelectedIndex = 0;
            };
            _scanTimer.Start();
        }

        private void BtnConnect_Click(object sender, RoutedEventArgs e)
        {
            if (!(CmbDevices.SelectedItem is SenzeBandDeviceInfo dev)) { Log("Select a device first."); return; }
            Log($"Connecting to {dev.DeviceName}…");
            BtnConnect.IsEnabled = false;
            ConnPill.Text = "Connecting…"; ConnDot.Fill = Warn;
            _ctl.Connect(dev.DeviceID);
        }

        private void BtnReauth_Click(object sender, RoutedEventArgs e)
        {
            Log("Re-attempting authentication…");
            _ctl.Authenticate(force: true);
        }

        private void BtnStartSession_Click(object sender, RoutedEventArgs e)
        {
            BtnStartSession.IsEnabled = false;
            bool dbOk = _ctl.StartSession();
            BtnStopSession.IsEnabled = true;
            Log(dbOk ? "Session started — uploading to database." :
                       "Session started — DB unreachable, NOT uploading (capture still works).");
        }

        private void BtnStopSession_Click(object sender, RoutedEventArgs e)
        {
            BtnStopSession.IsEnabled = false;
            _ctl.StopSession();   // flushes + closes upload; device stays connected
        }

        private void BtnCapture_Click(object sender, RoutedEventArgs e)
        {
            if (!_ctl.IsCapturing)
            {
                _ctl.StartCapture();
                BtnCapture.Content = "Stop & save";
                TxtCapture.Text = "capturing…";
            }
            else
            {
                int frames = _ctl.StopCapture();
                string path = _ctl.WriteCsv();
                BtnCapture.Content = "Start capture";
                TxtCapture.Text = path == null ? "no frames captured" : $"saved {frames} frames";
                if (path != null) Log("Capture saved → " + path);
            }
        }

        // ── Controller event handlers ────────────────────────────────────────
        private void OnConnected(string addr, string id)
        {
            ConnPill.Text = "Connected"; ConnDot.Fill = Good;
            Log($"Connected to {id} @ {addr}");
            BtnReauth.IsEnabled = true;
            BtnStartSession.IsEnabled = true;
            BtnCapture.IsEnabled = true;
        }

        private void OnDisconnected(string addr)
        {
            ConnPill.Text = "Disconnected"; ConnDot.Fill = Bad;
            Log("Disconnected (" + addr + ")");
        }

        private void OnAuth(bool ok, string detail)
        {
            AuthDot.Fill = ok ? Good : Bad;
            TxtAuth.Text = ok ? "authenticated" : "auth failed";
            Log(ok ? $"Authenticated ({detail}) — raw EEG unlocked." : $"Authentication failed ({detail}).");
        }

        private void OnSessionStarted()
        {
            TxtPairing.Text = _ctl.PairingCode;
            TxtSessionId.Text = _ctl.SessionId;
            TxtStarted.Text = _ctl.SessionStartUtc.ToString("yyyy-MM-dd HH:mm:ss") + " UTC";
        }

        private void OnSessionStopped()
        {
            // Device stays connected — allow starting a fresh session.
            BtnStartSession.IsEnabled = _ctl.IsConnected;
            BtnStopSession.IsEnabled = false;
            var db = _ctl.Db;
            Log(db != null
                ? $"Session stopped — {db.RawRowsSent:N0} raw rows uploaded this session."
                : "Session stopped.");
        }

        // ── Periodic refresh ─────────────────────────────────────────────────
        private void RefreshLiveState()
        {
            // DB status
            var db = _ctl.Db;
            if (db == null) { TxtDbState.Text = "not started"; TxtDbState.Foreground = Mut; }
            else
            {
                if (!_ctl.SessionActive) { TxtDbState.Text = "stopped"; TxtDbState.Foreground = Mut; }
                else { TxtDbState.Text = db.ClockAnchored ? "clock-synced — streaming" : "NOT connected"; TxtDbState.Foreground = db.ClockAnchored ? Good : Bad; }
                TxtRawRows.Text = db.RawRowsSent.ToString("N0");
                TxtEegRows.Text = db.EegRowsSent.ToString("N0");
                TxtBandRows.Text = db.BandRowsSent.ToString("N0");
                var extra = new List<string>();
                if (db.RawResyncs > 0) extra.Add($"{db.RawResyncs} resync(s)");
                long drops = db.Dropped + db.RawDropped;
                if (drops > 0) extra.Add($"{drops} dropped");
                extra.Add($"{db.RawFramesIn} frames in");
                TxtDbExtra.Text = string.Join("  ·  ", extra);
                TxtDbError.Text = string.IsNullOrEmpty(db.LastError) ? "" : "last error: " + db.LastError;
            }

            // Signal & contact
            var s = _ctl.Snapshot();
            int q = SignalQuality.Compute(s.SignalReady, s.Channels);
            TxtQuality.Text = $"{q}/100 · {SignalQuality.Label(q)}";
            BarQuality.Value = q;
            BarQuality.Foreground = q >= 75 ? Good : q >= 40 ? Warn : Bad;
            TxtSignal.Text = s.SignalReady == null ? "(no data)" : s.SignalReady.Value ? "READY" : "settling…";
            TxtBattery.Text = s.Battery == null ? "(no data)" : s.Battery + "%";

            var rows = new List<string>();
            for (int ch = 0; ch < BridgeController.ChannelCount; ch++)
            {
                string lbl = BridgeController.ChannelLabels[ch];
                bool? ok = s.Channels != null && ch < s.Channels.Length ? s.Channels[ch] : (bool?)null;
                float k = s.Impedance != null && ch < s.Impedance.Length ? s.Impedance[ch] : float.NaN;
                string contact = ok == null ? "?" : ok.Value ? "OK" : "--";
                string kTxt = float.IsNaN(k) ? "n/a" : $"{k:F1} kΩ ({SignalQuality.GradeImpedance(k)})";
                rows.Add($"{lbl,-4} contact={contact,-2}   {kTxt}");
            }
            ChannelList.ItemsSource = rows;
        }

        private void RefreshDeviceList()
        {
            var selectedId = (CmbDevices.SelectedItem as SenzeBandDeviceInfo)?.DeviceID;
            var devices = _ctl.SnapshotDevices();
            CmbDevices.ItemsSource = null;
            CmbDevices.ItemsSource = devices;
            if (selectedId != null)
            {
                var match = devices.FirstOrDefault(d => d.DeviceID == selectedId);
                if (match != null) CmbDevices.SelectedItem = match;
            }
            else if (devices.Count > 0 && CmbDevices.SelectedIndex < 0)
                CmbDevices.SelectedIndex = 0;
        }

        // ── Helpers ──────────────────────────────────────────────────────────
        private void Ui(Action a)
        {
            if (Dispatcher.CheckAccess()) a();
            else Dispatcher.BeginInvoke(a);
        }

        private void AppendLog(string m)
        {
            LogBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {m}{Environment.NewLine}");
            LogBox.ScrollToEnd();
        }

        private void Log(string m) => AppendLog(m);
    }
}
