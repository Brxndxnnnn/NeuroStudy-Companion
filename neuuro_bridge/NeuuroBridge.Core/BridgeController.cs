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
    /// <summary>
    /// UI-agnostic orchestration of the whole bridge lifecycle — SDK init → scan → connect →
    /// authenticate → session → DB upload → stream — plus all live state and CSV capture.
    /// The console app and the WPF app both drive this; neither owns SDK/DB wiring directly.
    ///
    /// Threading: SDK callbacks arrive on whatever <see cref="SynchronizationContext"/> was
    /// current when <see cref="Initialize"/> ran. In WPF (initialised on the UI thread) the
    /// events below therefore raise on the UI thread, so handlers can touch UI directly.
    /// Per-sample DB timestamps are captured synchronously in the SDK layer, so upload
    /// fidelity does not depend on which thread these events run on.
    /// </summary>
    public class BridgeController : IDisposable
    {
        public const int ChannelCount = 4;
        public static readonly string[] ChannelLabels = { "Fp1", "Fp2", "T4", "T3" };

        private readonly SenzeBandService _svc = SenzeBandService.Instance;
        private readonly EegProcessor _processor = new EegProcessor();
        private DbUploader _db;

        private readonly object _devLock = new object();
        private readonly Dictionary<string, SenzeBandDeviceInfo> _devices = new Dictionary<string, SenzeBandDeviceInfo>();

        private readonly object _stateLock = new object();
        private long _rawFrameCount;
        private readonly Stopwatch _dbEegThrottle = Stopwatch.StartNew();

        // Live snapshots (guarded by _stateLock).
        private int[] _lastRawInt;
        private float[] _lastFiltered;
        private float[,] _sdkAbdt;
        private float _sdkAttention = float.NaN, _sdkRelaxation = float.NaN, _sdkMentalWorkload = float.NaN;
        private BandPowers[] _fftPowers;
        private bool? _signalReady;
        private bool[] _channels;
        private float[] _impedance;
        private string _battery;

        // Session identity.
        private string _connAddress = "", _connDeviceID = "";
        private SenzeBandDeviceInfo _connDevice;

        // CSV capture.
        private volatile bool _capturing;
        private readonly Stopwatch _captureWatch = new Stopwatch();
        private readonly List<(long Ms, long Frame, int[] Samples)> _captureBuf = new List<(long, long, int[])>();
        private readonly object _captureLock = new object();

        private bool _wired;

        // ── Events (raised on the SDK callback's marshalled thread) ───────────
        public event Action<string> Log;
        public event Action Initialized;
        public event Action DevicesChanged;
        public event Action<string, string> Connected;       // address, deviceId
        public event Action<string> Disconnected;
        public event Action<bool, string> AuthChanged;       // ok, detail
        public event Action SessionStarted;
        public event Action SessionStopped;
        public event Action<RawEegFrame> RawFrame;           // every raw frame (for waveform charts)
        public event Action<BandPowers[]> FftBandPowers;     // ~1/s FFT result
        public event Action SdkCognitiveChanged;             // attention/relaxation/mwl/ABDT updated
        public event Action SignalStateChanged;              // signalReady/channels/impedance/battery

        // ── State accessors ──────────────────────────────────────────────────
        public bool IsConnected => _svc.IsConnected;
        public bool IsAuthenticated => _svc.IsAuthenticated;
        public bool SessionActive { get; private set; }
        public bool IsStreaming => SessionActive;
        public bool IsCapturing => _capturing;
        public DbUploader Db => _db;
        public long RawFrameCount => Interlocked.Read(ref _rawFrameCount);

        public string SessionId { get; private set; } = "";
        public string PairingCode { get; private set; } = "";
        public DateTime SessionStartUtc { get; private set; }

        public string ConnectedDeviceName => _connDevice?.DeviceName;
        public string ConnectedDeviceId => _connDeviceID;
        public string ConnectedAddress => _connAddress;

        public List<SenzeBandDeviceInfo> SnapshotDevices()
        {
            lock (_devLock) return _devices.Values.ToList();
        }

        /// <summary>Thread-safe snapshot of all live signal/EEG state for a UI refresh.</summary>
        public LiveState Snapshot()
        {
            lock (_stateLock)
            {
                return new LiveState
                {
                    RawInt = _lastRawInt,
                    Filtered = _lastFiltered,
                    SdkAbdt = _sdkAbdt,
                    Attention = _sdkAttention,
                    Relaxation = _sdkRelaxation,
                    MentalWorkload = _sdkMentalWorkload,
                    FftPowers = _fftPowers,
                    SignalReady = _signalReady,
                    Channels = _channels,
                    Impedance = _impedance,
                    Battery = _battery,
                };
            }
        }

        // ── Lifecycle ────────────────────────────────────────────────────────
        /// <summary>Wires SDK events and initialises the SDK. Fires <see cref="Initialized"/> when ready.</summary>
        public void Initialize(string license)
        {
            if (!_wired) { Wire(); _wired = true; }
            _svc.Initialize(license ?? "");
        }

        private void Wire()
        {
            _svc.OnLog += m => Log?.Invoke(m);
            _svc.OnInitialized += () => Initialized?.Invoke();
            _svc.OnDeviceFound += (d, added) =>
            {
                lock (_devLock) { if (added) _devices[d.DeviceID] = d; else _devices.Remove(d.DeviceID); }
                DevicesChanged?.Invoke();
            };
            _svc.OnDeviceUpdated += d => { lock (_devLock) _devices[d.DeviceID] = d; DevicesChanged?.Invoke(); };
            _svc.OnConnected += (addr, id) =>
            {
                _connAddress = addr; _connDeviceID = id;
                lock (_devLock) { _devices.TryGetValue(id, out var d); _connDevice = d; }
                Connected?.Invoke(addr, id);
            };
            _svc.OnDisconnected += addr => Disconnected?.Invoke(addr);
            _svc.OnSignalReady += ready => { lock (_stateLock) _signalReady = ready; SignalStateChanged?.Invoke(); };
            _svc.OnChannelStatus += ch => { lock (_stateLock) _channels = ch; SignalStateChanged?.Invoke(); };
            _svc.OnImpedance += imp => { lock (_stateLock) _impedance = imp; SignalStateChanged?.Invoke(); };
            _svc.OnBattery += b => { lock (_stateLock) _battery = b; SignalStateChanged?.Invoke(); };
            _svc.OnRawEeg += HandleRawEeg;
            _svc.OnFilteredEeg += f => { lock (_stateLock) _lastFiltered = f; };
            _svc.OnFilteredEeg += f => _processor.AddFilteredFrame(f);
            _svc.OnAuthStatus += (ok, detail) => AuthChanged?.Invoke(ok, detail);

            _svc.OnAttention += v => { lock (_stateLock) _sdkAttention = v; SdkCognitiveChanged?.Invoke(); };
            _svc.OnRelaxation += v => { lock (_stateLock) _sdkRelaxation = v; SdkCognitiveChanged?.Invoke(); };
            _svc.OnMentalWorkload += v => { lock (_stateLock) _sdkMentalWorkload = v; SdkCognitiveChanged?.Invoke(); };
            _svc.OnAbdt += v => { lock (_stateLock) _sdkAbdt = v; SdkCognitiveChanged?.Invoke(); };

            _processor.OnBandPowers += powers => { lock (_stateLock) _fftPowers = powers; };
            _processor.OnBandPowers += UploadBandPowers;
            _processor.OnBandPowers += powers => FftBandPowers?.Invoke(powers);
        }

        public bool StartScan() => _svc.StartScan();
        public void StopScan() => _svc.StopScan();
        public void Connect(string deviceId) => _svc.Connect(deviceId);
        public void Authenticate(bool force = false) => _svc.Authenticate(force);

        /// <summary>Ends any active session, then disconnects the device but keeps the app/SDK
        /// alive so the technician can scan/connect again. Fires <see cref="Disconnected"/>.</summary>
        public void Disconnect()
        {
            StopSession();
            string addr = _connAddress;
            try { _svc.Disconnect(); } catch { /* ignore */ }
            // Fire explicitly so the UI resets even if the SDK's own disconnect callback doesn't.
            Disconnected?.Invoke(addr);
        }

        /// <summary>
        /// Generates the session identity, connects + anchors the DB clock, creates the
        /// unclaimed session row, and starts streaming. Safe to call once connected (and ideally
        /// authenticated). Returns the DB connection result (false = streaming without upload).
        /// </summary>
        public bool StartSession()
        {
            GenerateSession(_connAddress);
            bool dbOk = StartDbUpload();
            _svc.StartStream();
            SessionActive = true;
            SessionStarted?.Invoke();
            return dbOk;
        }

        /// <summary>
        /// Ends the current session: stops streaming and flushes + closes the DB upload (final
        /// drain), while keeping the device connected so another session can be started. The
        /// disposed uploader is kept referenced so its final row counts stay visible. Idempotent.
        /// </summary>
        public void StopSession()
        {
            if (!SessionActive) return;
            SessionActive = false;
            try { _svc.StopStream(); } catch { /* ignore */ }
            try { _db?.Dispose(); } catch { /* ignore */ }
            SessionStopped?.Invoke();
        }

        private void GenerateSession(string bleAddress)
        {
            SessionStartUtc = DateTime.UtcNow;
            SessionId = Guid.NewGuid().ToString();
            PairingCode = BuildPairingCode(bleAddress, SessionStartUtc);
        }

        private static string BuildPairingCode(string bleAddress, DateTime utc)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes($"{bleAddress}|{utc:yyyyMMddHHmmss}"));
                return BitConverter.ToString(hash).Replace("-", "").Substring(0, 6).ToUpperInvariant();
            }
        }

        private bool StartDbUpload()
        {
            _db = new DbUploader(EnvConfig.BuildConnectionString(), m => Log?.Invoke("[db] " + m));
            if (!_db.Connect()) return false;
            int sampleRate = EegProcessor.SampleRate == 125 ? 125 : 250;
            return _db.CreateSession(Guid.Parse(SessionId), _connAddress, PairingCode, sampleRate, SessionStartUtc);
        }

        // ── SDK raw frame handling (mirrors the console path) ────────────────
        private void HandleRawEeg(RawEegFrame frame)
        {
            if (frame.IntSamples != null)
            {
                Interlocked.Increment(ref _rawFrameCount);
                lock (_stateLock) _lastRawInt = frame.IntSamples;

                if (_capturing)
                {
                    long ms = _captureWatch.ElapsedMilliseconds;
                    long fn = Interlocked.Read(ref _rawFrameCount);
                    lock (_captureLock) _captureBuf.Add((ms, fn, (int[])frame.IntSamples.Clone()));
                }

                // Capture a local ref: StopSession may dispose _db on another thread mid-frame.
                var db = _db;
                if (SessionActive && db != null && db.Streaming)
                {
                    db.EnqueueRaw(db.ToDbTime(frame.ArrivalUtc), frame.IntSamples);
                    if (_dbEegThrottle.ElapsedMilliseconds >= 500)
                    {
                        _dbEegThrottle.Restart();
                        UploadEegSnapshot();
                    }
                }
            }

            RawFrame?.Invoke(frame);
        }

        private void UploadEegSnapshot()
        {
            int[] raw; float[] filt;
            lock (_stateLock) { raw = _lastRawInt; filt = _lastFiltered; }
            if (raw == null && filt == null) return;

            var row = new EegReadingRow
            {
                Time = _db.DbNow,
                RawLast = raw != null ? new float[ChannelCount] : null,
                RawPkpk = raw != null ? new float[ChannelCount] : null,
                FiltLast = filt != null ? new float[ChannelCount] : null,
                FiltPkpk = filt != null ? new float[ChannelCount] : null,
            };
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                if (raw != null) { var s = IntLastPkpk(raw, ch); row.RawLast[ch] = s.last; row.RawPkpk[ch] = s.pkpk; }
                if (filt != null) { var s = FloatLastPkpk(filt, ch); row.FiltLast[ch] = s.last; row.FiltPkpk[ch] = s.pkpk; }
            }
            _db.EnqueueEeg(row);
        }

        private void UploadBandPowers(BandPowers[] powers)
        {
            if (!SessionActive || _db == null || !_db.Streaming) return;
            float att, rel, mwl; bool? ready; bool[] channels;
            lock (_stateLock)
            {
                att = _sdkAttention; rel = _sdkRelaxation; mwl = _sdkMentalWorkload;
                ready = _signalReady; channels = _channels;
            }
            _db.EnqueueBand(new BandPowerRow
            {
                Time = _db.DbNow,
                Attention = att,
                Relaxation = rel,
                MentalWorkload = mwl,
                SignalQuality = SignalQuality.Compute(ready, channels),
                Bands = powers,
            });
        }

        // ── CSV capture ──────────────────────────────────────────────────────
        public void StartCapture()
        {
            lock (_captureLock) _captureBuf.Clear();
            _captureWatch.Restart();
            _capturing = true;
        }

        public int StopCapture()
        {
            _capturing = false;
            lock (_captureLock) return _captureBuf.Count;
        }

        /// <summary>Writes the captured frames to a CSV and returns the full path (or null if empty).</summary>
        public string WriteCsv(string directory = null)
        {
            List<(long Ms, long Frame, int[] Samples)> frames;
            lock (_captureLock) frames = new List<(long, long, int[])>(_captureBuf);
            if (frames.Count == 0) return null;

            string filename = $"raw_{SessionId}_{DateTime.UtcNow:yyyyMMdd_HHmmss}.csv";
            string path = directory != null ? Path.Combine(directory, filename) : filename;

            using (var sw = new StreamWriter(path, false, Encoding.UTF8))
            {
                sw.WriteLine("elapsed_ms,frame,sample_idx,Fp1,Fp2,T4,T3");
                foreach (var (ms, frameNum, samples) in frames)
                {
                    if (samples == null || samples.Length < ChannelCount) continue;
                    int spc = samples.Length / ChannelCount;
                    for (int s = 0; s < spc; s++)
                    {
                        sw.Write(ms); sw.Write(','); sw.Write(frameNum); sw.Write(','); sw.Write(s);
                        for (int ch = 0; ch < ChannelCount; ch++) { sw.Write(','); sw.Write(samples[ch * spc + s]); }
                        sw.WriteLine();
                    }
                }
            }
            return Path.GetFullPath(path);
        }

        // ── Per-channel helpers (frame = ChannelCount equal blocks) ──────────
        public static (float last, float pkpk) IntLastPkpk(int[] d, int ch)
        {
            if (d == null || d.Length < ChannelCount) return (0f, 0f);
            int n = d.Length / ChannelCount, start = ch * n;
            int min = int.MaxValue, max = int.MinValue;
            for (int i = start; i < start + n; i++) { int v = d[i]; if (v < min) min = v; if (v > max) max = v; }
            return (d[start + n - 1], max - min);
        }

        public static (float last, float pkpk) FloatLastPkpk(float[] d, int ch)
        {
            if (d == null || d.Length < ChannelCount) return (0f, 0f);
            int n = d.Length / ChannelCount, start = ch * n;
            float min = float.MaxValue, max = float.MinValue;
            for (int i = start; i < start + n; i++) { float v = d[i]; if (v < min) min = v; if (v > max) max = v; }
            return (d[start + n - 1], max - min);
        }

        public void Dispose()
        {
            try { _svc.StopStream(); } catch { /* ignore */ }
            try { _db?.Dispose(); } catch { /* ignore */ }
            try { _svc.Shutdown(); } catch { /* ignore */ }
        }
    }

    /// <summary>Immutable snapshot of live signal/EEG state for a UI refresh.</summary>
    public class LiveState
    {
        public int[] RawInt;
        public float[] Filtered;
        public float[,] SdkAbdt;
        public float Attention, Relaxation, MentalWorkload;
        public BandPowers[] FftPowers;
        public bool? SignalReady;
        public bool[] Channels;
        public float[] Impedance;
        public string Battery;
    }
}
