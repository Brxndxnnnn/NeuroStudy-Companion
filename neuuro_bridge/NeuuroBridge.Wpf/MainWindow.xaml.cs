using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace NeuuroBridge.Wpf
{
    public partial class MainWindow : Window
    {
        private readonly BridgeController _ctl = new BridgeController();
        private readonly DispatcherTimer _refresh = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
        private DispatcherTimer _scanTimer;

        // Signal-quality accumulation over the recording window (local only, never uploaded):
        // one tick per 500 ms refresh while recording, bucketed good/fair/poor.
        private int _qGoodTicks, _qFairTicks, _qPoorTicks;

        private bool _logOpen;

        // Persists the in-app log to disk alongside the SDK's own numbered log files, so things
        // like BleConnectionTuner's "was the faster interval actually granted?" outcome survive
        // past the session instead of only ever existing in the (never-saved) on-screen log box.
        // Readable timestamp filename, unlike the SDK's raw-tick names, for easy eyeballing side by
        // side. Best-effort: a failure to open/write must never take the app down with it.
        private StreamWriter _logFile;

        private static readonly Brush Good = (Brush)new BrushConverter().ConvertFromString("#22C55E");
        private static readonly Brush Warn = (Brush)new BrushConverter().ConvertFromString("#F59E0B");
        private static readonly Brush Bad  = (Brush)new BrushConverter().ConvertFromString("#EF4444");
        private static readonly Brush Mut  = (Brush)new BrushConverter().ConvertFromString("#6B7A90");

        public MainWindow()
        {
            InitializeComponent();
            Loaded += OnLoaded;
            Closing += OnWindowClosing;
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            OpenLogFile();

            // Controller events marshal to whatever thread is current at Initialize() — the UI
            // thread here — but guard with Ui() anyway in case a callback slips in off-thread.
            _ctl.Log += m => Ui(() => AppendLog(m));
            _ctl.Initialized += () => Ui(() => { Log("SDK initialized."); BtnScan.IsEnabled = true; });
            _ctl.DevicesChanged += () => Ui(RefreshDeviceList);
            _ctl.Connected += (addr, id) => Ui(() => OnConnected(addr, id));
            _ctl.ConnectionInterrupted += () => Ui(OnConnectionInterrupted);
            _ctl.Reconnected += () => Ui(OnReconnected);
            _ctl.Disconnected += addr => Ui(() => OnDisconnected(addr));
            _ctl.AuthChanged += (ok, detail) => Ui(() => OnAuth(ok, detail));
            _ctl.StreamingChanged += () => Ui(OnStreamingChanged);
            _ctl.SessionPrepared += () => Ui(OnSessionPrepared);
            _ctl.SyncStatusChanged += () => Ui(OnSyncStatusChanged);
            _ctl.SessionStarted += () => Ui(OnSessionStarted);
            _ctl.SessionStopped += () => Ui(OnSessionStopped);
            _ctl.RawFrame += f => Ui(() => LivePanel.PushRaw(f.IntSamples));
            _ctl.FftBandPowers += p => Ui(() => LivePanel.PushBands(p));
            _ctl.SessionEvents += list => Ui(() => LivePanel.PushEvents(list));
            _ctl.BlinkDetected += ts => Ui(() => LivePanel.PushBlinkMarker(ts));
            _ctl.ClenchDetected += ts => Ui(() => LivePanel.PushClenchMarker(ts));

            _refresh.Tick += (_, __) => RefreshLiveState();
            _refresh.Start();

            string version = BridgeController.AppVersion;
            TxtAppVersion.Text = string.IsNullOrEmpty(version) ? "" : "v" + version;

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
            SetConn("Connecting…", Warn);
            _ctl.Connect(dev.DeviceID);
        }

        private void BtnReauth_Click(object sender, RoutedEventArgs e)
        {
            Log("Re-attempting authentication…");
            _ctl.Authenticate(force: true);
        }

        private void BtnDisconnect_Click(object sender, RoutedEventArgs e)
        {
            if (_ctl.SessionActive &&
                MessageBox.Show("A session is uploading. Stop it and disconnect?", "Disconnect",
                    MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
                return;
            Log("Disconnecting…");
            _ctl.Disconnect();
        }

        private void BtnCopyPairing_Click(object sender, RoutedEventArgs e)
        {
            if (!string.IsNullOrEmpty(_ctl.PairingCode))
            {
                try { Clipboard.SetText(_ctl.PairingCode); Log($"Pairing code {_ctl.PairingCode} copied to clipboard."); }
                catch (Exception ex) { Log("Copy failed: " + ex.Message); }
            }
        }

        private void BtnStartSession_Click(object sender, RoutedEventArgs e)
        {
            BtnStartSession.IsEnabled = false;   // re-armed by RefreshSessionHint for the NEXT claimed session
            Log("Starting session…");
            _ctl.StartSession();
        }

        private void BtnStopSession_Click(object sender, RoutedEventArgs e)
        {
            BtnStopSession.IsEnabled = false;
            _ctl.StopSession();   // drains in-flight BLE frames briefly, then flushes + closes upload; device stays connected
        }

        private void BtnToggleLog_Click(object sender, RoutedEventArgs e)
        {
            _logOpen = !_logOpen;
            BtnToggleLog.Content = _logOpen ? "Hide log ▲" : "Show log ▼";
            var anim = new DoubleAnimation(_logOpen ? 120 : 0, TimeSpan.FromMilliseconds(180))
            {
                EasingFunction = new QuadraticEase()
            };
            LogPanel.BeginAnimation(HeightProperty, anim);
        }

        private void BtnCapture_Click(object sender, RoutedEventArgs e)
        {
            if (!_ctl.IsCapturing)
            {
                _ctl.StartCapture();
                BtnCapture.Content = "Stop & save";
                TxtCapture.Text = "recording…";
            }
            else
            {
                int frames = _ctl.StopCapture();
                string path = _ctl.WriteCsv();
                BtnCapture.Content = "Start test recording";
                TxtCapture.Text = path == null ? "no frames captured" : $"saved {frames} frames";
                if (path != null) Log("Capture saved → " + path);
            }
        }

        // ── Controller event handlers ────────────────────────────────────────
        private void OnConnected(string addr, string id)
        {
            SetConn("Connected", Good);
            Log($"Connected to {id} @ {addr}");
            // Lock scanning/connecting while a device is held.
            BtnScan.IsEnabled = false;
            BtnConnect.IsEnabled = false;
            CmbDevices.IsEnabled = false;
            BtnDisconnect.IsEnabled = true;
            BtnReauth.IsEnabled = true;
            BtnCapture.IsEnabled = true;
            RefreshSessionHint();   // shows "waiting to pair" until the website claims the session
        }

        // Transient BLE drop — the bridge is auto-reconnecting to the same device, session preserved.
        private void OnConnectionInterrupted()
        {
            SetConn("Reconnecting…", Warn);
            SetAuth("reconnecting…", Mut);
            Log("Link dropped — reconnecting (session preserved)…");
        }

        // Link restored — recording continues in the same session; auth re-arms via OnAuth.
        private void OnReconnected()
        {
            SetConn("Connected", Good);
            Log("Reconnected — session resumed.");
        }

        private void OnDisconnected(string addr)
        {
            SetConn("Disconnected", Bad);
            SetAuth("not authenticated", Mut);
            Log("Disconnected (" + addr + ")");
            // Back to a scan/connect-ready state; reconnect without rescanning if devices remain.
            BtnScan.IsEnabled = true;
            CmbDevices.IsEnabled = true;
            BtnConnect.IsEnabled = CmbDevices.Items.Count > 0;
            BtnDisconnect.IsEnabled = false;
            BtnReauth.IsEnabled = false;
            BtnStartSession.IsEnabled = false;
            BtnStopSession.IsEnabled = false;
            BtnCapture.IsEnabled = false;
            TxtPairHint.Visibility = Visibility.Collapsed;
            RecDot.Visibility = Visibility.Collapsed; TxtElapsed.Text = "";
            // Clear the session card — a reconnect prepares a fresh session/code.
            TxtPairing.Text = "—"; TxtSessionId.Text = "—"; TxtStarted.Text = "—";
            BtnCopyPairing.IsEnabled = false;
            TxtSyncStatus.Text = "—"; SyncDot.Fill = Mut;
            ResetProgressSteps();
            TxtQualitySummary.Visibility = Visibility.Collapsed;
            TxtDbSummary.Visibility = Visibility.Collapsed;
            LivePanel.Clear();
        }

        private void OnWindowClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (_ctl.SessionActive &&
                MessageBox.Show("A session is still uploading. Stop it and exit?", "Exit",
                    MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                e.Cancel = true;
                return;
            }
            try { _ctl.Dispose(); } catch { }
            try { _logFile?.Dispose(); } catch { }
        }

        private void OnAuth(bool ok, string detail)
        {
            SetAuth(ok ? "authenticated" : "auth failed", ok ? Good : Bad);
            Log(ok ? $"Authenticated ({detail}) — raw EEG unlocked." : $"Authentication failed ({detail}).");
        }

        private void OnStreamingChanged()
        {
            if (_ctl.IsStreaming)
                Log("Live preview started — signal/contact now, waveform once authenticated. " +
                    "Recording begins automatically when the website starts the session.");
        }

        private void OnSessionPrepared()
        {
            // Session row + pairing code now exist (created on connect) — show them so the frontend
            // can claim before the technician records. Recording is still gated behind Start.
            TxtPairing.Text = _ctl.PairingCode;
            TxtSessionId.Text = _ctl.SessionId;
            TxtStarted.Text = _ctl.SessionStartUtc.ToString("yyyy-MM-dd HH:mm:ss") + " UTC";
            BtnCopyPairing.IsEnabled = true;
            OnSyncStatusChanged();
        }

        private void OnSyncStatusChanged()
        {
            string s = _ctl.SyncStatus;
            if (string.IsNullOrEmpty(s)) { TxtSyncStatus.Text = "—"; SyncDot.Fill = Mut; }
            else
            {
                TxtSyncStatus.Text = s;
                // unclaimed = amber (waiting on frontend), claimed = green, completed = muted (done).
                SyncDot.Fill = s == "claimed" ? Good : s == "completed" ? Mut : Warn;
            }
            RefreshSessionHint();
        }

        private void OnSessionStarted()
        {
            BtnStopSession.IsEnabled = true;
            // Fresh recording window: restart the quality tally and clear last session's verdicts.
            _qGoodTicks = _qFairTicks = _qPoorTicks = 0;
            TxtQualitySummary.Visibility = Visibility.Collapsed;
            TxtDbSummary.Visibility = Visibility.Collapsed;
            RefreshSessionHint();
        }

        private void OnSessionStopped()
        {
            BtnStopSession.IsEnabled = false;
            RefreshSessionHint();
            ShowEndOfSessionSummary();
        }

        // End-of-session reconciliation: expected rows (recording duration × known stream rates)
        // vs actually-sent rows, plus the signal-quality time breakdown — the technician's proof
        // that the session's data really landed in the DB.
        private void ShowEndOfSessionSummary()
        {
            double secs = _ctl.RecordingElapsed.TotalSeconds;
            var db = _ctl.Db;
            if (db == null || secs <= 0) { Log("Session stopped."); return; }

            // "Expected" is measured against BLE uptime (recording time minus signal dropout and any
            // stop-grace tail loss), so the percentage isolates upload fidelity from those two,
            // separately-reported causes. eeg_readings (summary) rows are excluded — display-only
            // snapshot, not a reconciled stream.
            double uptime = Math.Max(0, secs - db.RawGapSeconds - _ctl.TailLossSeconds);
            long sent = db.RawRowsSent + db.FiltRowsSent + db.BandRowsSent;
            long expected = ExpectedRows(uptime, DbUploader.RawRowsPerSecond)
                          + ExpectedRows(uptime, DbUploader.FilteredRowsPerSecond)
                          + ExpectedRows(uptime, DbUploader.BandRowsPerSecond);
            double pct = expected > 0 ? Math.Min(100.0, 100.0 * sent / expected) : 0;
            string mb = (db.ApproxBytesSent / (1024.0 * 1024.0)).ToString("F1");

            string dropNote = db.RawGapSeconds >= 0.5
                ? $" {db.RawGapSeconds:F1}s of Bluetooth signal dropout across {db.RawResyncs} gap(s) was not recorded by the headset."
                : "";
            // The filtered stream is what ml_service trains on, so its dropout — not the raw
            // stream's — is what bounds epoch yield. Reported separately because the two streams
            // anchor independently and carry different drift tolerances (see DbUploader).
            string filtNote = db.FiltGapSeconds >= 0.5
                ? $" Analysis stream: {db.FiltCoverageSeconds:F0}s of EEG captured, {db.FiltGapSeconds:F1}s lost " +
                  $"across {db.FiltResyncs} gap(s) ({100.0 * db.FiltGapSeconds / Math.Max(1.0, secs):F0}% of the session)."
                : "";
            // Normally zero — the stop-grace window (see BridgeController.StopGraceMs) drains the
            // in-flight BLE tail before the session closes. Only shows if that window wasn't enough.
            string tailNote = _ctl.TailLossSeconds >= 0.5
                ? $" {_ctl.TailLossSeconds:F1}s of buffered signal was still in flight when the grace window closed and was not recorded."
                : "";
            TxtDbSummary.Text = $"Session complete — uploaded {sent:N0} of ~{expected:N0} expected rows " +
                                $"({pct:F1}% of received signal) · ≈{mb} MB over {FmtDur(secs)}.{dropNote}{filtNote}{tailNote}";
            TxtDbSummary.Foreground = pct >= 98 ? Good : pct >= 90 ? Warn : Bad;
            TxtDbSummary.Visibility = Visibility.Visible;
            Log(TxtDbSummary.Text);

            int total = _qGoodTicks + _qFairTicks + _qPoorTicks;
            if (total > 0)
            {
                int g = (int)Math.Round(100.0 * _qGoodTicks / total);
                int f = (int)Math.Round(100.0 * _qFairTicks / total);
                int p = Math.Max(0, 100 - g - f);
                TxtQualitySummary.Text = $"Signal quality during this {FmtDur(secs)} recording: " +
                                         $"GOOD {g}% · FAIR {f}% · POOR {p}% of the time.";
                TxtQualitySummary.Foreground = g >= 75 ? Good : g + f >= 75 ? Warn : Bad;
                TxtQualitySummary.Visibility = Visibility.Visible;
                Log(TxtQualitySummary.Text);
            }
        }

        private static long ExpectedRows(double seconds, double rowsPerSecond)
            => (long)Math.Round(seconds * rowsPerSecond);

        private static string FmtDur(double seconds)
        {
            var t = TimeSpan.FromSeconds(seconds);
            return t.TotalHours >= 1 ? $"{(int)t.TotalHours}:{t.Minutes:D2}:{t.Seconds:D2}"
                                     : $"{(int)t.TotalMinutes:D2}:{t.Seconds:D2}";
        }

        // ── Periodic refresh ─────────────────────────────────────────────────
        private void RefreshLiveState()
        {
            // Recording indicator + elapsed (blink the dot for a "live" feel).
            if (_ctl.SessionActive)
            {
                RecDot.Visibility = Visibility.Visible;
                RecDot.Opacity = RecDot.Opacity > 0.6 ? 0.25 : 1.0;
                var el = DateTime.UtcNow - _ctl.RecordingStartUtc;
                TxtElapsed.Text = $"REC {(int)el.TotalMinutes:D2}:{el.Seconds:D2}";
            }
            else
            {
                RecDot.Visibility = Visibility.Collapsed;
                TxtElapsed.Text = "";
            }

            // DB status
            var db = _ctl.Db;
            if (db == null)
            {
                // No uploader yet. Distinguish the cases so the technician knows whether data is
                // landing: mid-recording with no DB is a LOUD problem (recording locally only);
                // just after connect it is the normal brief "connecting to the DB" window.
                if (_ctl.SessionActive) { TxtDbState.Text = "NOT connected — recording locally only"; TxtDbState.Foreground = Bad; }
                else if (_ctl.IsConnected) { TxtDbState.Text = "connecting to DB…"; TxtDbState.Foreground = Warn; }
                else { TxtDbState.Text = "not started"; TxtDbState.Foreground = Mut; }
            }
            else
            {
                if (!_ctl.SessionActive)
                {
                    // Prepared on connect but not recording yet vs. after a stop.
                    TxtDbState.Text = db.RawRowsSent > 0 ? "stopped" : "ready — not recording";
                    TxtDbState.Foreground = Mut;
                }
                else { TxtDbState.Text = db.ClockAnchored ? "clock-synced — streaming" : "NOT connected"; TxtDbState.Foreground = db.ClockAnchored ? Good : Bad; }
                TxtRawRows.Text = db.RawRowsSent.ToString("N0");
                TxtFiltRows.Text = db.FiltRowsSent.ToString("N0");
                TxtBandRows.Text = db.BandRowsSent.ToString("N0");

                // Sent-vs-expected: BLE-UPTIME × known stream rates. "Expected" subtracts detected
                // signal dropout (RawGapSeconds) and any stop-grace tail loss so the % reflects UPLOAD
                // fidelity (bridge→DB), not Bluetooth loss upstream. Both are surfaced on their own
                // line if non-zero. Live while recording, frozen after stop (RecordingElapsed freezes)
                // so the comparison stays on screen. eeg_readings (summary) rows are still written but
                // excluded here — they're a display-only "latest state" snapshot, not one of the
                // reconciled data streams.
                double secs = _ctl.RecordingElapsed.TotalSeconds;
                if (secs > 0)
                {
                    double uptime = Math.Max(0, secs - db.RawGapSeconds - _ctl.TailLossSeconds);
                    long expRaw  = ExpectedRows(uptime, DbUploader.RawRowsPerSecond);
                    long expFilt = ExpectedRows(uptime, DbUploader.FilteredRowsPerSecond);
                    long expBand = ExpectedRows(uptime, DbUploader.BandRowsPerSecond);
                    TxtRawExp.Text  = $"of ~{expRaw:N0}";
                    TxtFiltExp.Text = $"of ~{expFilt:N0}";
                    TxtBandExp.Text = $"of ~{expBand:N0}";

                    long sent = db.RawRowsSent + db.FiltRowsSent + db.BandRowsSent;
                    long expected = expRaw + expFilt + expBand;
                    double pct = expected > 0 ? Math.Min(100.0, 100.0 * sent / expected) : 0;
                    double mb = db.ApproxBytesSent / (1024.0 * 1024.0);
                    string dropout = db.RawGapSeconds >= 0.5
                        ? $"  ·  ⚠ {db.RawGapSeconds:F1}s signal dropout ({db.RawResyncs} gap{(db.RawResyncs == 1 ? "" : "s")})"
                        : "";
                    string tail = _ctl.TailLossSeconds >= 0.5
                        ? $"  ·  ⚠ {_ctl.TailLossSeconds:F1}s stop-grace tail loss"
                        : "";
                    TxtDbVolume.Text = $"≈{mb:F1} MB uploaded · {pct:F1}% of expected for {FmtDur(uptime)} of signal{dropout}{tail}";
                }
                else
                {
                    TxtRawExp.Text = TxtFiltExp.Text = TxtBandExp.Text = "";
                    TxtDbVolume.Text = "";
                }

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
            int q = SignalQuality.Compute(s.SignalReady, s.Channels, s.ChannelLive);
            TxtQuality.Text = $"{q}/100 · {SignalQuality.Label(q)}";
            BarQuality.Value = q;
            BarQuality.Foreground = q >= 75 ? Good : q >= 40 ? Warn : Bad;

            // Tally quality over the recording window (one tick per refresh) for the end-of-session
            // breakdown. Buckets match the bar colours: good ≥75, fair ≥40, poor below.
            if (_ctl.SessionActive)
            {
                if (q >= 75) _qGoodTicks++;
                else if (q >= 40) _qFairTicks++;
                else _qPoorTicks++;
            }
            TxtSignal.Text = s.SignalReady == null ? "(no data)" : s.SignalReady.Value ? "READY" : "settling…";
            TxtBattery.Text = s.Battery == null ? "(no data)" : s.Battery + "%";
            LivePanel.SetVitals(s.HeartRate, s.Spo2);

            var rows = new List<string>();
            for (int ch = 0; ch < BridgeController.ChannelCount; ch++)
            {
                string lbl = BridgeController.ChannelLabels[ch];
                string loc = ch < BridgeController.ChannelLocations.Length ? BridgeController.ChannelLocations[ch] : "";
                bool? ok = s.Channels != null && ch < s.Channels.Length ? s.Channels[ch] : (bool?)null;
                float k = s.Impedance != null && ch < s.Impedance.Length ? s.Impedance[ch] : float.NaN;
                // A flat-lined electrode is dead however cheerful the SDK's contact flag is —
                // say so loudly, since this is the failure that reads as healthy.
                bool flat = s.ChannelLive != null && ch < s.ChannelLive.Length && !s.ChannelLive[ch];
                string contact = flat ? "FLAT" : ok == null ? "?" : ok.Value ? "OK" : "--";
                rows.Add($"{lbl} · {loc}  —  contact={contact,-4}   {SignalQuality.FormatImpedance(k)}"
                    + (flat ? "   ⚠ NO SIGNAL — reseat this electrode" : ""));
            }
            ChannelList.ItemsSource = rows;

            LivePanel.SetCognitive(s.Attention, s.Relaxation, s.MentalWorkload);

            // Session progress checklist (advisory DB poll; see BridgeController.Progress).
            // Three states: green = done, yellow = the stage currently underway, grey = not started.
            // A stage counts as DONE only once a later stage has begun (e.g. "Showing images" stays
            // yellow while images are on screen and goes green when math questions start).
            var pg = _ctl.Progress;
            bool prepared = _ctl.IsPrepared;
            SetStep(DotPgPair, NumPgPair, TxtPgPair, LinePgPair,
                pg.Claimed ? StepState.Done : prepared ? StepState.Active : StepState.Pending);
            // "Baseline 1" covers claim through the whole first countdown/baseline block —
            // it isn't done until the first image actually appears (recording-confirmed alone
            // used to mark the old "Recording" step done in ~1s, which under the 13-step
            // protocol would show it complete while baseline 1 still had ~2.5 minutes left).
            SetStep(DotPgRec, NumPgRec, TxtPgRec, LinePgRec,
                pg.ImagesShown ? StepState.Done : pg.Claimed ? StepState.Active : StepState.Pending);
            SetStep(DotPgImg, NumPgImg, TxtPgImg, LinePgImg,
                pg.ImagesShown && (pg.QuestionsShown || pg.Ended) ? StepState.Done :
                pg.ImagesShown ? StepState.Active : StepState.Pending);
            SetStep(DotPgMath, NumPgMath, TxtPgMath, LinePgMath,
                pg.QuestionsShown && (pg.Baseline2Shown || pg.Ended) ? StepState.Done :
                pg.QuestionsShown ? StepState.Active : StepState.Pending);
            // "Baseline 2" — active once the post-math phase block starts, done once the bridge
            // actually stops recording (see BridgeController.PollSyncStatus / Baseline2Shown).
            SetStep(DotPgEnd, NumPgEnd, TxtPgEnd, LinePgEnd,
                pg.Ended ? StepState.Done : pg.Baseline2Shown ? StepState.Active : StepState.Pending);
            SetStep(DotPgSurvey, NumPgSurvey, TxtPgSurvey, null,
                pg.SurveySubmitted ? StepState.Done : pg.Ended ? StepState.Active : StepState.Pending);

            RefreshQuestionnaireScores(pg);
        }

        // WHO's screening cut-off: a percentage score below 50 (raw below 13) suggests poor well-being.
        private const decimal Who5LowPercent = 50m;
        private static readonly string[] BfiDomainOrder = { "E", "A", "C", "N", "O" };
        private static readonly Dictionary<string, string> BfiDomainNames = new Dictionary<string, string>
        {
            { "E", "Extraversion" }, { "A", "Agreeableness" }, { "C", "Conscientiousness" },
            { "N", "Neg. Emotionality" }, { "O", "Open-Mindedness" }
        };

        // Shows the scores panel once any questionnaire has been saved; the numbers fill in as the
        // website submits BFI-2 and then WHO-5.
        private void RefreshQuestionnaireScores(SessionProgress pg)
        {
            var scores = pg.Scores;
            if (!pg.SurveyStarted || scores == null)
            {
                PanelScores.Visibility = Visibility.Collapsed;
                return;
            }
            PanelScores.Visibility = Visibility.Visible;

            var who5 = scores.Find(s => s.Code == "who5" && s.Level == "total");
            if (who5.Code == null)
            {
                TxtWho5Score.Text = "—";
                TxtWho5Raw.Text = "";
                TxtWho5Note.Text = "waiting for the WHO-5 answers";
                TxtWho5Note.Foreground = (Brush)FindResource("Muted2");
            }
            else
            {
                TxtWho5Score.Text = who5.PercentageScore.ToString("0.#") + " / 100";
                TxtWho5Raw.Text = "raw " + who5.RawScore + " / 25";
                bool low = who5.PercentageScore < Who5LowPercent;
                TxtWho5Note.Text = who5.IsComplete
                    ? (low ? "Low well-being (below 50)" : "Within normal range")
                    : "partial: " + who5.AnsweredItems + " of " + who5.ExpectedItems + " items";
                TxtWho5Note.Foreground = (Brush)FindResource(!who5.IsComplete ? "Warn" : low ? "Warn" : "Good");
            }

            BfiGrid.Children.Clear();
            bool anyBfi = false, bfiPartial = false;
            foreach (var d in BfiDomainOrder)
            {
                var row = scores.Find(s => s.Code == "bfi2" && s.Level == "domain" && s.Domain == d);
                if (row.Code != null) { anyBfi = true; if (!row.IsComplete) bfiPartial = true; }
                var cell = new StackPanel { Margin = new Thickness(0, 0, 8, 0) };
                cell.Children.Add(new TextBlock
                {
                    Text = row.Code == null ? "—" : row.MeanScore.ToString("0.00"),
                    FontSize = 20, FontFamily = new FontFamily("Consolas"), FontWeight = FontWeights.Bold
                });
                cell.Children.Add(new TextBlock
                {
                    Text = BfiDomainNames[d], FontSize = 11, Foreground = (Brush)FindResource("Muted2"),
                    TextTrimming = TextTrimming.CharacterEllipsis
                });
                BfiGrid.Children.Add(cell);
            }
            TxtBfiNote.Text = !anyBfi ? "waiting for the BFI-2 answers"
                : bfiPartial ? "partial: some BFI-2 items are still unanswered" : "";
        }

        private enum StepState { Pending, Active, Done }

        // Marker colours per state (done = filled Good + ✓, active = AccentSoft fill / Accent
        // border+numeral, todo = Panel2 fill / PanelEdge border) — see the design handoff. Brushes
        // are per-element SolidColorBrush instances declared inline in XAML (not shared
        // StaticResources), so each can be eased independently without touching its neighbours.
        private static readonly Color DoneBg = Color.FromRgb(0x22, 0xC5, 0x5E);
        private static readonly Color DoneFg = Color.FromRgb(0x0B, 0x12, 0x1C);
        private static readonly Color ActiveBg = Color.FromRgb(0x1E, 0x2A, 0x3C);
        private static readonly Color ActiveFg = Color.FromRgb(0x3B, 0x82, 0xF6);
        private static readonly Color TodoBg = Color.FromRgb(0x12, 0x1A, 0x26);
        private static readonly Color TodoBorder = Color.FromRgb(0x26, 0x34, 0x4A);
        private static readonly Color TodoFg = Color.FromRgb(0x6B, 0x7A, 0x90);

        private static void SetStep(Border marker, System.Windows.Controls.TextBlock numeral,
            System.Windows.Controls.TextBlock label, Rectangle lineOut, StepState state)
        {
            Color bg, border, fg;
            switch (state)
            {
                case StepState.Done: bg = DoneBg; border = DoneBg; fg = DoneFg; break;
                case StepState.Active: bg = ActiveBg; border = ActiveFg; fg = ActiveFg; break;
                default: bg = TodoBg; border = TodoBorder; fg = TodoFg; break;
            }
            AnimateBrush(marker.Background, bg);
            AnimateBrush(marker.BorderBrush, border);
            AnimateBrush(numeral.Foreground, fg);
            numeral.Text = state == StepState.Done ? "✓" : (string)numeral.Tag;
            label.Opacity = state == StepState.Pending ? 0.55 : 1.0;
            if (lineOut != null)
                AnimateBrush(lineOut.Fill, state == StepState.Done ? DoneBg : TodoBorder);
        }

        private static void AnimateBrush(Brush brush, Color to, int ms = 260)
        {
            if (brush is SolidColorBrush scb)
                scb.BeginAnimation(SolidColorBrush.ColorProperty, new ColorAnimation(to, TimeSpan.FromMilliseconds(ms)));
        }

        private void ResetProgressSteps()
        {
            SetStep(DotPgPair, NumPgPair, TxtPgPair, LinePgPair, StepState.Pending);
            SetStep(DotPgRec, NumPgRec, TxtPgRec, LinePgRec, StepState.Pending);
            SetStep(DotPgImg, NumPgImg, TxtPgImg, LinePgImg, StepState.Pending);
            SetStep(DotPgMath, NumPgMath, TxtPgMath, LinePgMath, StepState.Pending);
            SetStep(DotPgEnd, NumPgEnd, TxtPgEnd, LinePgEnd, StepState.Pending);
            SetStep(DotPgSurvey, NumPgSurvey, TxtPgSurvey, null, StepState.Pending);
            PanelScores.Visibility = Visibility.Collapsed;
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
            string line = $"[{DateTime.Now:HH:mm:ss}] {m}";

            // Colour the line by severity so errors/warnings stand out in the log.
            var para = new Paragraph(new Run(line))
            {
                Margin = new Thickness(0),
                Foreground = SeverityBrush(m)
            };
            LogBox.Document.Blocks.Add(para);
            LogBox.ScrollToEnd();

            try { _logFile?.WriteLine(line); } catch { /* best-effort — never let logging break the app */ }
        }

        private void OpenLogFile()
        {
            try
            {
                string dir = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
                Directory.CreateDirectory(dir);
                string path = System.IO.Path.Combine(dir, $"bridge_{DateTime.Now:yyyyMMdd_HHmmss}.txt");
                _logFile = new StreamWriter(path, append: true) { AutoFlush = true };
            }
            catch { _logFile = null; /* in-app log box still works without it */ }
        }

        private static Brush SeverityBrush(string m)
        {
            if (m.IndexOf("ERROR", StringComparison.OrdinalIgnoreCase) >= 0 ||
                m.IndexOf("fail",  StringComparison.OrdinalIgnoreCase) >= 0)
                return Bad;
            if (m.IndexOf("WARN", StringComparison.OrdinalIgnoreCase) >= 0)
                return Warn;
            return Mut;
        }

        private void Log(string m) => AppendLog(m);

        // Status indicators are always a coloured dot + a label, set together — keep them in sync.
        private void SetConn(string text, Brush dot) { ConnPill.Text = text; ConnDot.Fill = dot; }
        private void SetAuth(string text, Brush dot) { TxtAuth.Text = text; AuthDot.Fill = dot; }

        // While connected but not yet claimed by the website, show the "waiting to pair" hint, and
        // gate Start Session on the website having claimed the session (client requirement #8: the
        // bridge starts recording itself once the technician presses this — see BtnStartSession_Click).
        private void RefreshSessionHint()
        {
            string s = _ctl.SyncStatus;
            bool waiting = _ctl.IsConnected && !_ctl.SessionActive
                           && (string.IsNullOrEmpty(s) || s == "unclaimed");
            TxtPairHint.Visibility = waiting ? Visibility.Visible : Visibility.Collapsed;
            BtnStartSession.IsEnabled = _ctl.IsConnected && !_ctl.SessionActive && s == "claimed";
        }
    }
}
