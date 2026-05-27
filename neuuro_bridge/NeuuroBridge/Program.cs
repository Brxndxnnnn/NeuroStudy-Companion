using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
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
        private static volatile bool _showRaw;          // gates raw-EEG console output
        private static long _rawFrameCount;
        private static bool? _signalReady;
        private static string _battery;
        private static bool[] _channels;
        private static int[] _lastRawInt;
        private static float[] _lastFiltered;
        private static readonly Stopwatch _rawThrottle = Stopwatch.StartNew();

        private const int ChannelCount = 4;   // Fp1, Fp2, T4, T3 — frame is ChannelCount * samplesPerChannel

        // Channel labels per the SenzeBand layout (see SDK docs).
        private static readonly string[] ChannelLabels = { "Fp1", "Fp2", "T4", "T3" };

        private static string _connAddress = "";
        private static string _connDeviceID = "";
        private static SenzeBandDeviceInfo _connDevice;

        private static SenzeBandService _svc;

        private static void Main(string[] args)
        {
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

            // 6) Start streaming; the menu controls what's shown.
            _svc.StartStream();

            // 7) Interactive menu
            RunMenu();

            // 7) Shut down
            Print("\nStopping...");
            _svc.StopStream();
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
                Print("  1. Show live EEG (raw + filtered, per channel)");
                Print("  2. Show SenzeBand device info");
                Print("  3. Show signal & battery status");
                Print("  4. Re-attempt authentication");
                Print("  5. Disconnect and exit");
                Print("======================");
                Console.Write("Choose [1-5]: ");

                switch ((Console.ReadLine() ?? "").Trim())
                {
                    case "1": ShowLiveData(); break;
                    case "2": ShowDeviceInfo(); break;
                    case "3": ShowStatus(); break;
                    case "4": Print("Re-attempting authentication..."); _svc.Authenticate(force: true); break;
                    case "5": return;
                    default: Print("Invalid choice."); break;
                }
            }
        }

        private static void ShowLiveData()
        {
            Print("\n--- Live EEG (press ENTER to return to menu) ---");
            Print("raw = ADC counts (large DC offset); filt = band-passed, zero-centred. pk-pk = max-min over the frame.");
            _rawThrottle.Restart();
            _showRaw = true;
            Console.ReadLine();   // block here; frames print from callback threads
            _showRaw = false;
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
            }
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
            }

            if (!_showRaw) return;
            // Throttle to ~2 snapshots/sec so the stream stays readable.
            if (_rawThrottle.ElapsedMilliseconds < 500) return;
            _rawThrottle.Restart();
            PrintEegSnapshot();
        }

        private static void PrintEegSnapshot()
        {
            int[] raw; float[] filt;
            lock (_stateLock) { raw = _lastRawInt; filt = _lastFiltered; }

            Print($"\n[frame {Interlocked.Read(ref _rawFrameCount)}]  ch     raw mean   raw pk-pk    filt last   filt pk-pk");
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                var r = IntChannelStats(raw, ch);
                var f = FloatChannelStats(filt, ch);
                Print(string.Format("            {0,-4} {1,10} {2,11}   {3,10} {4,11}",
                    ChannelLabels[ch], r.a, r.b, f.a, f.b));
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

        private static string ResolveLicense(string[] args)
        {
            if (args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]))
                return args[0].Trim();

            var env = Environment.GetEnvironmentVariable("NEUURO_LICENSE_KEY");
            if (!string.IsNullOrWhiteSpace(env))
                return env.Trim();

            Console.Write("Enter Neeuro license key: ");
            return (Console.ReadLine() ?? "").Trim();
        }

        private static void Print(string message) => Console.WriteLine(message);
    }
}
