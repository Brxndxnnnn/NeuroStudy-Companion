using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace NeuuroBridge
{
    internal static class Program
    {
        private static readonly object _devLock = new object();
        private static readonly Dictionary<string, SenzeBandDeviceInfo> _devices =
            new Dictionary<string, SenzeBandDeviceInfo>();

        private static readonly ManualResetEventSlim _initialized = new ManualResetEventSlim(false);
        private static readonly ManualResetEventSlim _connected = new ManualResetEventSlim(false);
        private static readonly ManualResetEventSlim _authed = new ManualResetEventSlim(false);

        // ── Live state, updated by SDK callbacks (threadpool threads) ───────
        private static readonly object _stateLock = new object();
        private static volatile int _displayMode;        // 0=off 1=sdk-only 2=fft-only 3=both
        private static long _rawFrameCount;
        private static bool? _signalReady;
        private static string _battery;
        private static bool[] _channels;
        private static float[] _impedance;     // per-electrode impedance, frame order (Fp1, Fp2, T4, T3)
        private static int[] _lastRawInt;
        private static float[] _lastFiltered;
        private static readonly Stopwatch _rawThrottle = Stopwatch.StartNew();
        private static readonly Stopwatch _dbEegThrottle = Stopwatch.StartNew();   // batch window for DB upload

        // ── SDK cognitive features ───────────────────────────────────────────
        private static float _sdkAttention     = float.NaN;
        private static float _sdkRelaxation    = float.NaN;
        private static float _sdkMentalWorkload = float.NaN;
        private static float[,] _sdkAbdt;   // [channelIdx, bandIdx]: 0=Alpha 1=Beta 2=Delta 3=Theta

        // ── Custom FFT processor ─────────────────────────────────────────────
        private static EegProcessor _processor;
        private static BandPowers[] _fftPowers;

        private const int ChannelCount = 4;   // Fp1, Fp2, T4, T3 — frame is ChannelCount * samplesPerChannel

        // Channel labels per the SenzeBand layout (see SDK docs).
        private static readonly string[] ChannelLabels = { "Fp1", "Fp2", "T4", "T3" };

        private static string _connAddress = "";
        private static string _connDeviceID = "";
        private static SenzeBandDeviceInfo _connDevice;

        private static SenzeBandService _svc;

        // ── Session identity ─────────────────────────────────────────────────
        private static string _sessionId = "";       // UUID v4 — DB key
        private static string _pairingCode = "";     // 6-char code — typed into web frontend
        private static DateTime _sessionStartUtc;

        // ── Direct DB upload (TS1.6) ─────────────────────────────────────────
        private static DbUploader _db;

        // ── CSV capture state ────────────────────────────────────────────────
        private static volatile bool _capturing;
        private static readonly Stopwatch _captureWatch = new Stopwatch();
        private static readonly List<(long Ms, long Frame, int[] Samples)> _captureBuf =
            new List<(long, long, int[])>();
        private static readonly object _captureLock = new object();

        private static void Main(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.Title = "Neuuro Bridge — SenzeBand EEG";
            Print("=== Neuuro Bridge ===");

            string license = ResolveLicense(args);
            _svc = SenzeBandService.Instance;

            _svc.OnLog += m => Print("  [bridge] " + m);
            _svc.OnInitialized += () => _initialized.Set();
            _svc.OnDeviceFound += HandleDeviceFound;
            _svc.OnDeviceUpdated += d => { lock (_devLock) _devices[d.DeviceID] = d; };
            _svc.OnConnected += HandleConnected;
            _svc.OnDisconnected += addr => Print($"\n[!] Disconnected ({addr})");
            _svc.OnSignalReady += ready => { lock (_stateLock) _signalReady = ready; };
            _svc.OnChannelStatus += ch => { lock (_stateLock) _channels = ch; };
            _svc.OnImpedance += imp => { lock (_stateLock) _impedance = imp; };
            _svc.OnBattery += b => { lock (_stateLock) _battery = b; };
            _svc.OnRawEeg += HandleRawEeg;
            _svc.OnFilteredEeg += f => { lock (_stateLock) _lastFiltered = f; };
            _svc.OnAuthStatus += (ok, detail) =>
            {
                Print(ok
                    ? $"\n[AUTH] Authenticated ({detail}) — raw EEG unlocked."
                    : $"\n[AUTH] Authentication FAILED ({detail}). Raw EEG will not stream.");
                if (ok) _authed.Set();
            };

            _svc.OnAttention      += v => { lock (_stateLock) _sdkAttention = v; };
            _svc.OnRelaxation     += v => { lock (_stateLock) _sdkRelaxation = v; };
            _svc.OnMentalWorkload += v => { lock (_stateLock) _sdkMentalWorkload = v; };
            _svc.OnAbdt           += v => { lock (_stateLock) _sdkAbdt = v; };

            _processor = new EegProcessor();
            _svc.OnFilteredEeg += f => _processor.AddFilteredFrame(f);
            _processor.OnBandPowers += powers => { lock (_stateLock) _fftPowers = powers; };
            _processor.OnBandPowers += UploadBandPowers;   // TS1.6: one band_powers row per FFT fire (~1/s)

            // 1) Initialize
            Print("Initializing SDK...");
            _svc.Initialize(license);
            if (!_initialized.Wait(TimeSpan.FromSeconds(30)))
            {
                Print("ERROR: SDK did not initialize within 30s. Check the license key and DLLs.");
                return;
            }

            // 2) Scan
            Print("\nScanning for SenzeBands (12s)... make sure the band is ON.");
            if (!_svc.StartScan())
            {
                Print("ERROR: scan failed to start (is Bluetooth ON?).");
                return;
            }
            Thread.Sleep(TimeSpan.FromSeconds(12));
            _svc.StopScan();

            // 3) Pick a device
            var found = SnapshotDevices();
            if (found.Count == 0)
            {
                Print("No devices found. Make sure the band is on and in range, then re-run.");
                return;
            }

            Print("\nDevices found:");
            for (int i = 0; i < found.Count; i++)
                Print($"  [{i}] {found[i].DeviceName}  (id={found[i].DeviceID})");

            var target = found[PromptIndex("Select a device", found.Count)];

            // 4) Connect
            Print($"\nConnecting to {target.DeviceName}...");
            _svc.Connect(target.DeviceID);
            if (!_connected.Wait(TimeSpan.FromSeconds(30)))
            {
                Print("ERROR: connection timed out.");
                _svc.Shutdown();
                return;
            }

            // 5) Authenticate (STANDARD tier) BEFORE streaming — raw EEG is gated on it.
            if (!_svc.IsAuthenticated)
            {
                Print("Waiting for server authentication...");
                if (!_authed.Wait(TimeSpan.FromSeconds(30)))
                    Print("WARNING: not authenticated yet — raw EEG may not stream. (Menu option 4 retries.)");
            }

            // 6) Generate session identity now that we have a confirmed BLE address.
            GenerateSession(_connAddress);

            // 6b) Connect to the DB, anchor the bridge clock to DB time, create the
            //     unclaimed session row. Failure is non-fatal — streaming/CSV still work.
            StartDbUpload();

            // 7) Start streaming; the menu controls what's shown.
            _svc.StartStream();

            // 8) Interactive menu
            RunMenu();

            // 7) Shut down. Exiting the console ends the session, so mark it 'completed'
            //    (flag flips sync_status after the final flush — see DbUploader.RequestComplete).
            Print("\nStopping...");
            _svc.StopStream();
            _db?.RequestComplete();
            _db?.Dispose();   // flush the final EEG/band batch, then mark completed, before exit
            _svc.Shutdown();
            Print("Done.");
        }

        // ── Menu ────────────────────────────────────────────────────────────
        private static void RunMenu()
        {
            while (true)
            {
                Print("");
                Print("======== MENU ========");
                Print($"  Session ID   : {_sessionId}");
                Print($"  Pairing Code : {_pairingCode}  ← enter this on the web frontend");
                Print($"  Started      : {_sessionStartUtc:yyyy-MM-dd HH:mm:ss} UTC");
                Print($"  DB upload    : {DbStatusLine()}");
                Print("----------------------");
                Print("  1. Live EEG — SDK data only  (attention, relaxation, ABDT band powers)");
                Print("  2. Live EEG — FFT data only  (custom band powers)");
                Print("  3. Live EEG — both SDK and FFT");
                Print("  4. Live EEG — raw ADC samples (Fp1, Fp2, T4, T3 integer values)");
                Print("  5. Impedance & signal-quality check (live)");
                Print("  6. Capture raw session → CSV");
                Print("  7. Show SenzeBand device info");
                Print("  8. Show signal & battery status");
                Print("  9. Re-attempt authentication");
                Print(" 10. Disconnect and exit");
                Print("======================");
                Console.Write("Choose [1-10]: ");

                switch ((Console.ReadLine() ?? "").Trim())
                {
                    case "1": ShowLiveData(1); break;
                    case "2": ShowLiveData(2); break;
                    case "3": ShowLiveData(3); break;
                    case "4": ShowLiveData(4); break;
                    case "5": ShowImpedanceCheck(); break;
                    case "6": CaptureSession(); break;
                    case "7": ShowDeviceInfo(); break;
                    case "8": ShowStatus(); break;
                    case "9": Print("Re-attempting authentication..."); _svc.Authenticate(force: true); break;
                    case "10": return;
                    default: Print("Invalid choice."); break;
                }
            }
        }

        private static void ShowLiveData(int mode)
        {
            string label = mode == 1 ? "SDK only" : mode == 2 ? "FFT only" : mode == 3 ? "SDK + FFT" : "raw samples";
            Print($"\n--- Live EEG [{label}] (press ENTER to return to menu) ---");
            if (mode == 4)
                Print("Raw ADC integer samples per channel, as delivered by the SDK (large DC offset present).");
            else
                Print("raw = ADC counts (large DC offset); filt = band-passed, zero-centred. pk-pk = max-min over the frame.");
            _rawThrottle.Restart();
            _displayMode = mode;
            Console.ReadLine();   // block here; frames print from callback threads
            _displayMode = 0;
            Print("--- stopped ---");
        }

        private static void ShowDeviceInfo()
        {
            Print("\n--- SenzeBand device info ---");
            Print($"  Name      : {_connDevice?.DeviceName ?? "(unknown)"}");
            Print($"  Device ID : {_connDeviceID}");
            Print($"  Address   : {_connAddress}");
            Print($"  Connected : {_svc.IsConnected}");
            Print($"  Frames    : {Interlocked.Read(ref _rawFrameCount)} raw frames received so far");
        }

        private static void ShowStatus()
        {
            Print("\n--- Signal & battery status ---");
            Print($"  Auth    : {(_svc.IsAuthenticated ? "AUTHENTICATED" : "not authenticated (raw EEG locked)")}");
            lock (_stateLock)
            {
                Print($"  Signal  : {(_signalReady == null ? "(no data yet)" : (_signalReady.Value ? "READY" : "settling..."))}");
                int q = SignalQuality.Compute(_signalReady, _channels);
                Print($"  Quality : {q}/100 [{SignalQuality.Label(q)}]");
                Print($"  Battery : {(_battery == null ? "(no data yet)" : _battery + "%")}");
                if (_channels == null)
                {
                    Print("  Channels: (no data yet)");
                }
                else
                {
                    var parts = _channels.Select((ok, i) =>
                        $"{(i < ChannelLabels.Length ? ChannelLabels[i] : "Ch" + i)}={(ok ? "OK" : "--")}");
                    Print("  Channels: " + string.Join("  ", parts));
                }
                if (_impedance != null)
                {
                    var parts = _impedance.Select((k, i) =>
                        $"{(i < ChannelLabels.Length ? ChannelLabels[i] : "Ch" + i)}={k:F1}kΩ");
                    Print("  Impedance: " + string.Join("  ", parts));
                }
            }
        }

        // ── Impedance & signal-quality check (TS1.3) ────────────────────────
        // Live electrode-contact view for fitting the headset before a session.
        // Refreshes ~2/s until ENTER. Per-channel impedance + contact status feed a
        // 0–100 signal-quality score (the same score written to band_powers).
        private static void ShowImpedanceCheck()
        {
            Print("\n--- Impedance & signal quality (press ENTER to return to menu) ---");
            Print("Fit the band so all four electrodes read GOOD and quality is high before pairing.");
            var refresh = Stopwatch.StartNew();

            while (true)
            {
                if (Console.KeyAvailable && Console.ReadKey(intercept: true).Key == ConsoleKey.Enter)
                    break;

                if (refresh.ElapsedMilliseconds >= 500)
                {
                    refresh.Restart();
                    bool? ready; bool[] channels; float[] imp;
                    lock (_stateLock) { ready = _signalReady; channels = _channels; imp = _impedance; }

                    int q = SignalQuality.Compute(ready, channels);
                    string readyTxt = ready == null ? "(no data)" : ready.Value ? "READY" : "settling...";
                    Print($"\n  signal={readyTxt}   quality={q}/100 [{SignalQuality.Label(q)}]");
                    for (int ch = 0; ch < ChannelCount; ch++)
                    {
                        bool? ok = channels != null && ch < channels.Length ? channels[ch] : (bool?)null;
                        float k = imp != null && ch < imp.Length ? imp[ch] : float.NaN;
                        string contact = ok == null ? "?" : ok.Value ? "OK" : "--";
                        string kTxt = float.IsNaN(k) ? "   n/a" : $"{k,6:F1}";
                        Print($"     {ChannelLabels[ch],-4} contact={contact,-2}  impedance={kTxt} kΩ ({SignalQuality.GradeImpedance(k)})");
                    }
                }
                Thread.Sleep(50);
            }
            Print("--- stopped ---");
        }

        private static string DbStatusLine()
        {
            if (_db == null) return "(not started)";
            string clock = _db.ClockAnchored ? "clock-synced" : "NOT connected";
            string err = string.IsNullOrEmpty(_db.LastError) ? "" : $"  last error: {_db.LastError}";
            long drops = _db.Dropped + _db.RawDropped;
            string drop = drops > 0 ? $", {drops} dropped" : "";
            return $"{clock} — {_db.EegRowsSent} eeg + {_db.BandRowsSent} band + {_db.RawRowsSent} raw rows sent{drop}{err}";
        }

        // ── SDK callbacks ───────────────────────────────────────────────────
        private static void HandleConnected(string address, string deviceID)
        {
            _connAddress = address;
            _connDeviceID = deviceID;
            lock (_devLock)
            {
                _devices.TryGetValue(deviceID, out var d);
                _connDevice = d;
            }
            Print($"\n[+] Connected to {deviceID} @ {address}");
            _connected.Set();
        }

        private static void HandleDeviceFound(SenzeBandDeviceInfo d, bool added)
        {
            lock (_devLock)
            {
                if (added) _devices[d.DeviceID] = d;
                else _devices.Remove(d.DeviceID);
            }
        }

        private static void HandleRawEeg(RawEegFrame frame)
        {
            if (frame.IntSamples != null)
            {
                Interlocked.Increment(ref _rawFrameCount);
                lock (_stateLock) _lastRawInt = frame.IntSamples;

                if (_capturing)
                {
                    long ms = _captureWatch.ElapsedMilliseconds;
                    long fn = Interlocked.Read(ref _rawFrameCount);
                    lock (_captureLock)
                        _captureBuf.Add((ms, fn, (int[])frame.IntSamples.Clone()));
                }

                // Full-resolution raw → eeg_raw_samples: every frame, every sample (no decimation).
                // Anchor each frame to its TRUE arrival instant (captured synchronously in the SDK
                // callback), mapped onto the DB clock — not DbNow read here on the pooled handler,
                // which lagged/jittered. frame.IntSamples is already a private clone (see OnRawInt).
                if (_db != null && _db.Streaming)
                    _db.EnqueueRaw(_db.ToDbTime(frame.ArrivalUtc), frame.IntSamples);

                // TS1.6: snapshot one eeg_readings row per ~500 ms window (batched, not per frame).
                if (_db != null && _db.Streaming && _dbEegThrottle.ElapsedMilliseconds >= 500)
                {
                    _dbEegThrottle.Restart();
                    UploadEegSnapshot();
                }
            }

            if (_displayMode == 0) return;
            // Throttle to ~2 snapshots/sec so the stream stays readable.
            if (_rawThrottle.ElapsedMilliseconds < 500) return;
            _rawThrottle.Restart();
            if (_displayMode == 4) PrintRawSamples();
            else PrintEegSnapshot();
        }

        private static void PrintEegSnapshot()
        {
            int mode = _displayMode;
            int[] raw; float[] filt;
            float[,] sdkAbdt; float sdkAtt, sdkRel, sdkMwl; BandPowers[] fftPow;
            lock (_stateLock)
            {
                raw = _lastRawInt; filt = _lastFiltered;
                sdkAbdt = _sdkAbdt; sdkAtt = _sdkAttention; sdkRel = _sdkRelaxation;
                sdkMwl = _sdkMentalWorkload; fftPow = _fftPowers;
            }

            Print($"\n[frame {Interlocked.Read(ref _rawFrameCount)}]  ch     raw mean   raw pk-pk    filt last   filt pk-pk");
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                var r = IntChannelStats(raw, ch);
                var f = FloatChannelStats(filt, ch);
                Print(string.Format("            {0,-4} {1,10} {2,11}   {3,10} {4,11}",
                    ChannelLabels[ch], r.a, r.b, f.a, f.b));
            }

            bool showSdk = mode == 1 || mode == 3;
            bool showFft = mode == 2 || mode == 3;

            if (showSdk)
            {
                string Fmt(float v) => float.IsNaN(v) ? "  ---  " : v.ToString("F3");
                Print($"\n  SDK  attention={Fmt(sdkAtt)}  relaxation={Fmt(sdkRel)}  mental-workload={Fmt(sdkMwl)}");

                if (sdkAbdt != null)
                {
                    // SDK delivers float[NUM_CHANNELS=4, NUM_FREQTYPES=5].
                    // Band order confirmed from SDK source: ABDT acronym + Gamma appended.
                    // [0]=Alpha  [1]=Beta  [2]=Delta  [3]=Theta  [4]=Gamma
                    string[] sdkBandNames = { "α", "β", "δ", "θ", "γ" };
                    int chs = sdkAbdt.GetLength(0), bands = sdkAbdt.GetLength(1);
                    Print("  SDK  ch     α(alpha)   β(beta)    δ(delta)   θ(theta)   γ(gamma)");
                    for (int ch = 0; ch < Math.Min(chs, ChannelCount); ch++)
                    {
                        var parts = new System.Text.StringBuilder($"       {ChannelLabels[ch],-4}");
                        for (int b = 0; b < bands; b++)
                        {
                            string lbl = b < sdkBandNames.Length ? sdkBandNames[b] : b.ToString();
                            parts.Append($"  {lbl}={sdkAbdt[ch, b]:F4}");
                        }
                        Print(parts.ToString());
                    }
                }
            }

            if (showFft)
            {
                if (fftPow != null)
                {
                    Print("  FFT  ch     δ(delta)   θ(theta)   α(alpha)    β(beta)   γ(gamma)");
                    for (int ch = 0; ch < ChannelCount; ch++)
                        Print($"       {ChannelLabels[ch],-4} {fftPow[ch]}");
                }
                else
                {
                    Print("  FFT  (accumulating — fires after first 256 filtered samples)");
                }
            }
        }

        private static void PrintRawSamples()
        {
            int[] raw;
            lock (_stateLock) raw = _lastRawInt;

            if (raw == null || raw.Length < ChannelCount)
            {
                Print("  (no raw data yet)");
                return;
            }

            int samplesPerCh = raw.Length / ChannelCount;
            Print($"\n[frame {Interlocked.Read(ref _rawFrameCount)}]  {samplesPerCh} samples/channel");
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                int start = ch * samplesPerCh;
                var sb = new System.Text.StringBuilder($"  {ChannelLabels[ch],-4}: ");
                for (int i = start; i < start + samplesPerCh; i++)
                {
                    sb.Append(raw[i]);
                    if (i < start + samplesPerCh - 1) sb.Append(", ");
                }
                Print(sb.ToString());
            }
        }

        // Frame layout: ChannelCount equal blocks, e.g. [Fp1..][Fp2..][T4..][T3..].
        private static (string a, string b) IntChannelStats(int[] d, int ch)
        {
            if (d == null || d.Length < ChannelCount) return ("--", "--");
            int n = d.Length / ChannelCount, start = ch * n;
            long sum = 0; int min = int.MaxValue, max = int.MinValue;
            for (int i = start; i < start + n; i++)
            {
                int v = d[i]; sum += v;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return ((sum / (double)n).ToString("F0"), (max - min).ToString());
        }

        private static (string a, string b) FloatChannelStats(float[] d, int ch)
        {
            if (d == null || d.Length < ChannelCount) return ("--", "--");
            int n = d.Length / ChannelCount, start = ch * n;
            float min = float.MaxValue, max = float.MinValue;
            for (int i = start; i < start + n; i++)
            {
                float v = d[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return (d[start + n - 1].ToString("F1"), (max - min).ToString("F1"));
        }

        // ── Helpers ─────────────────────────────────────────────────────────
        private static List<SenzeBandDeviceInfo> SnapshotDevices()
        {
            lock (_devLock) return _devices.Values.ToList();
        }

        private static int PromptIndex(string label, int count)
        {
            while (true)
            {
                Console.Write($"{label} [0-{count - 1}]: ");
                if (int.TryParse(Console.ReadLine(), out int idx) && idx >= 0 && idx < count)
                    return idx;
                Print("Invalid selection.");
            }
        }

        // Resolution order: command-line arg > NEUURO_LICENSE_KEY env var > .env file > prompt.
        private static string ResolveLicense(string[] args)
        {
            if (args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]))
                return args[0].Trim();

            var env = Environment.GetEnvironmentVariable("NEUURO_LICENSE_KEY");
            if (!string.IsNullOrWhiteSpace(env))
                return env.Trim();

            var fromFile = FindDotEnvValue("NEUURO_LICENSE_KEY");
            if (!string.IsNullOrWhiteSpace(fromFile))
            {
                Print("Using license key from .env file.");
                return fromFile;
            }

            Console.Write("Enter Neeuro license key: ");
            return (Console.ReadLine() ?? "").Trim();
        }

        // Looks for a ".env" file by walking up from the working directory and the
        // executable directory, then returns the requested KEY=VALUE entry.
        private static string FindDotEnvValue(string key)
        {
            foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            {
                var dir = start;
                for (int depth = 0; depth < 8 && dir != null; depth++)
                {
                    var path = Path.Combine(dir, ".env");
                    if (File.Exists(path))
                    {
                        var value = ReadEnvKey(path, key);
                        if (!string.IsNullOrWhiteSpace(value)) return value;
                    }
                    dir = Directory.GetParent(dir)?.FullName;
                }
            }
            return null;
        }

        private static string ReadEnvKey(string path, string key)
        {
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;

                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                if (!string.Equals(line.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) continue;

                var value = line.Substring(eq + 1).Trim();
                if (value.Length >= 2 &&
                    ((value[0] == '"' && value[value.Length - 1] == '"') ||
                     (value[0] == '\'' && value[value.Length - 1] == '\'')))
                    value = value.Substring(1, value.Length - 2);
                return value;
            }
            return null;
        }

        // ── CSV capture ──────────────────────────────────────────────────────
        private static void CaptureSession()
        {
            int minutes;
            while (true)
            {
                Console.Write("Capture duration in minutes [1-15]: ");
                if (int.TryParse(Console.ReadLine(), out minutes) && minutes >= 1 && minutes <= 15)
                    break;
                Print("Enter a number between 1 and 15.");
            }

            long durationMs = (long)minutes * 60_000L;
            Print($"Capturing {minutes} min of raw EEG. Press ENTER to stop early.");

            lock (_captureLock) _captureBuf.Clear();
            _captureWatch.Restart();
            _capturing = true;

            bool stopped = false;
            while (!stopped && _captureWatch.ElapsedMilliseconds < durationMs)
            {
                long secsLeft = (durationMs - _captureWatch.ElapsedMilliseconds + 999) / 1000;
                Print($"  {secsLeft}s remaining...");

                var tick = Stopwatch.StartNew();
                while (!stopped && tick.ElapsedMilliseconds < 2000)
                {
                    try
                    {
                        if (Console.KeyAvailable && Console.ReadKey(intercept: true).Key == ConsoleKey.Enter)
                            stopped = true;
                    }
                    catch (InvalidOperationException) { }
                    if (!stopped) Thread.Sleep(50);
                }
            }

            _capturing = false;
            long capturedMs = _captureWatch.ElapsedMilliseconds;

            int frameCount;
            lock (_captureLock) frameCount = _captureBuf.Count;
            Print($"\nCapture complete: {capturedMs / 1000.0:F1}s, {frameCount} frames captured.");

            WriteCsvFromBuffer();
        }

        private static void WriteCsvFromBuffer()
        {
            List<(long Ms, long Frame, int[] Samples)> frames;
            lock (_captureLock) frames = new List<(long, long, int[])>(_captureBuf);

            if (frames.Count == 0)
            {
                Print("No frames captured — CSV not written.");
                return;
            }

            string filename = $"raw_{_sessionId}_{DateTime.UtcNow:yyyyMMdd_HHmmss}.csv";
            int rowsWritten = 0;

            using (var sw = new StreamWriter(filename, append: false, encoding: Encoding.UTF8))
            {
                sw.WriteLine("elapsed_ms,frame,sample_idx,Fp1,Fp2,T4,T3");
                foreach (var (ms, frameNum, samples) in frames)
                {
                    if (samples == null || samples.Length < ChannelCount) continue;
                    int spc = samples.Length / ChannelCount;
                    for (int s = 0; s < spc; s++)
                    {
                        sw.Write(ms); sw.Write(',');
                        sw.Write(frameNum); sw.Write(',');
                        sw.Write(s);
                        for (int ch = 0; ch < ChannelCount; ch++)
                        {
                            sw.Write(',');
                            sw.Write(samples[ch * spc + s]);
                        }
                        sw.WriteLine();
                        rowsWritten++;
                    }
                }
            }

            Print($"Saved → {Path.GetFullPath(filename)}  ({rowsWritten} rows)");
        }

        // ── Session generation ───────────────────────────────────────────────
        private static void GenerateSession(string bleAddress)
        {
            _sessionStartUtc = DateTime.UtcNow;
            _sessionId       = Guid.NewGuid().ToString();
            _pairingCode     = BuildPairingCode(bleAddress, _sessionStartUtc);
            Print($"\n[Session] ID={_sessionId}  Pairing={_pairingCode}");
        }

        // Derives a 6-char uppercase alphanumeric code from the BLE address and
        // session start time. SHA-256 over "address|yyyyMMddHHmmss", take the
        // first 6 hex chars of the digest. Collision probability is negligible
        // for the expected session volume.
        private static string BuildPairingCode(string bleAddress, DateTime utc)
        {
            var input = $"{bleAddress}|{utc:yyyyMMddHHmmss}";
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(input));
                return BitConverter.ToString(hash).Replace("-", "").Substring(0, 6).ToUpperInvariant();
            }
        }

        // ── Direct DB upload (TS1.6) ─────────────────────────────────────────
        private static void StartDbUpload()
        {
            string connString = BuildConnectionString();
            _db = new DbUploader(connString, m => Print("  [db] " + m));

            if (!_db.Connect())
            {
                Print("[db] No database connection — EEG will NOT be uploaded (streaming/CSV still work).");
                return;
            }

            int sampleRate = EegProcessor.SampleRate == 125 ? 125 : 250;   // schema CHECK allows 125/250
            _db.CreateSession(Guid.Parse(_sessionId), _connAddress, _pairingCode, sampleRate, _sessionStartUtc);
        }

        // Builds an Npgsql connection string from .env (POSTGRES_* keys, same files the
        // rest of the stack uses), falling back to the dev compose defaults (localhost:5433).
        private static string BuildConnectionString()
        {
            string host = FindDotEnvValue("POSTGRES_HOST") ?? "localhost";
            string port = FindDotEnvValue("POSTGRES_PORT") ?? "5433";
            string dbName = FindDotEnvValue("POSTGRES_DB")   ?? "neurostudy";
            string user = FindDotEnvValue("POSTGRES_USER") ?? "neurostudy_user";
            string pass = FindDotEnvValue("POSTGRES_PASSWORD") ?? "neurostudy_pass";
            return $"Host={host};Port={port};Database={dbName};Username={user};Password={pass};" +
                   "Timeout=5;Command Timeout=10;Pooling=true";
        }

        private static void UploadEegSnapshot()
        {
            int[] raw; float[] filt;
            lock (_stateLock) { raw = _lastRawInt; filt = _lastFiltered; }
            if (raw == null && filt == null) return;

            var row = new EegReadingRow
            {
                Time     = _db.DbNow,
                RawLast  = raw  != null ? new float[ChannelCount] : null,
                RawPkpk  = raw  != null ? new float[ChannelCount] : null,
                FiltLast = filt != null ? new float[ChannelCount] : null,
                FiltPkpk = filt != null ? new float[ChannelCount] : null,
            };
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                if (raw != null)  { var s = IntLastPkpk(raw, ch);   row.RawLast[ch] = s.last;  row.RawPkpk[ch] = s.pkpk; }
                if (filt != null) { var s = FloatLastPkpk(filt, ch); row.FiltLast[ch] = s.last; row.FiltPkpk[ch] = s.pkpk; }
            }
            _db.EnqueueEeg(row);
        }

        private static void UploadBandPowers(BandPowers[] powers)
        {
            if (_db == null || !_db.Streaming) return;
            float att, rel, mwl; bool? ready; bool[] channels;
            lock (_stateLock)
            {
                att = _sdkAttention; rel = _sdkRelaxation; mwl = _sdkMentalWorkload;
                ready = _signalReady; channels = _channels;
            }
            _db.EnqueueBand(new BandPowerRow
            {
                Time           = _db.DbNow,
                Attention      = att,
                Relaxation     = rel,
                MentalWorkload = mwl,
                SignalQuality  = SignalQuality.Compute(ready, channels),
                Bands          = powers,
            });
        }

        // Numeric variants of the display stat helpers: last sample + peak-to-peak per channel.
        private static (float last, float pkpk) IntLastPkpk(int[] d, int ch)
        {
            if (d == null || d.Length < ChannelCount) return (0f, 0f);
            int n = d.Length / ChannelCount, start = ch * n;
            int min = int.MaxValue, max = int.MinValue;
            for (int i = start; i < start + n; i++)
            {
                int v = d[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return (d[start + n - 1], max - min);
        }

        private static (float last, float pkpk) FloatLastPkpk(float[] d, int ch)
        {
            if (d == null || d.Length < ChannelCount) return (0f, 0f);
            int n = d.Length / ChannelCount, start = ch * n;
            float min = float.MaxValue, max = float.MinValue;
            for (int i = start; i < start + n; i++)
            {
                float v = d[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return (d[start + n - 1], max - min);
        }

        private static void Print(string message) => Console.WriteLine(message);
    }
}
