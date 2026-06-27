using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace NeuuroBridge
{
    /// <summary>
    /// UI-agnostic orchestration of the whole bridge lifecycle — SDK init → scan → connect →
    /// authenticate → stream (live preview) → session → DB upload — plus all live state and CSV
    /// capture. Streaming starts on connect for preview; opening a DB session is a separate step.
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
        // Where each electrode sits on the head (10-20 system), in ChannelLabels order.
        public static readonly string[] ChannelLocations = { "Left forehead", "Right forehead", "Right temple", "Left temple" };

        private readonly SenzeBandService _svc = SenzeBandService.Instance;
        private readonly EegProcessor _processor = new EegProcessor();
        private DbUploader _db;

        private readonly object _devLock = new object();
        private readonly Dictionary<string, SenzeBandDeviceInfo> _devices = new Dictionary<string, SenzeBandDeviceInfo>();

        private readonly object _stateLock = new object();
        private long _rawFrameCount;
        private bool _streaming;
        private bool _prepared;                 // unclaimed session row + pairing code exist (created on connect)
        private bool _recordingConfirmed;       // bridge_recording_at written for the active session (handshake ack)
        private Timer _syncPoll;                // advisory poll of sessions.sync_status (read-only + lifecycle react)
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
        private int? _heartRate;
        private int? _spo2;

        // Session identity.
        private string _connAddress = "", _connDeviceID = "";
        private SenzeBandDeviceInfo _connDevice;

        // CSV capture.
        private volatile bool _capturing;
        private readonly Stopwatch _captureWatch = new Stopwatch();
        private readonly List<(long Ms, long Frame, int[] Samples)> _captureBuf = new List<(long, long, int[])>();
        private readonly object _captureLock = new object();

        // ── TEMPORARY (client request): raw-vs-filtered comparison capture ────────
        // Records the SDK's raw-float (µV) and filtered (µV) streams in parallel so the
        // two can be diffed side by side in one CSV. Paired by arrival index (both derive
        // from the same hardware stream). Each frame's arrival UTC is stored so the CSV can
        // emit a DB-style uniform per-sample timestamp plus the raw arrival for verification.
        // Independent of the raw-int CSV capture above. Remove when done.
        private const int RvfSampleRateHz = 250;   // true hardware rate (matches DbUploader; NOT EegProcessor.SampleRate=256)
        private volatile bool _rvfCapturing;
        private readonly List<(DateTime Arrival, float[] Samples)> _rvfRaw = new List<(DateTime, float[])>();
        private readonly List<(DateTime Arrival, float[] Samples)> _rvfFilt = new List<(DateTime, float[])>();
        private readonly object _rvfLock = new object();

        private bool _wired;

        // ── Events (raised on the SDK callback's marshalled thread) ───────────
        public event Action<string> Log;
        public event Action Initialized;
        public event Action DevicesChanged;
        public event Action<string, string> Connected;       // address, deviceId
        public event Action ConnectionInterrupted;           // transient BLE drop; reconnecting, session preserved
        public event Action Reconnected;                     // BLE link restored; same session resumed
        public event Action<string> Disconnected;
        public event Action<bool, string> AuthChanged;       // ok, detail
        public event Action StreamingChanged;                // live preview started/stopped (no DB session)
        public event Action SessionPrepared;                 // unclaimed session row + pairing code created (on connect)
        public event Action SyncStatusChanged;               // sessions.sync_status changed (unclaimed/claimed/completed)
        public event Action SessionStarted;                  // recording/upload began (Start pressed)
        public event Action SessionStopped;
        public event Action<RawEegFrame> RawFrame;           // every raw frame (for waveform charts)
        public event Action<BandPowers[]> FftBandPowers;     // ~1/s FFT result
        public event Action SdkCognitiveChanged;             // attention/relaxation/mwl/ABDT updated
        public event Action SignalStateChanged;              // signalReady/channels/impedance/battery

        // ── State accessors ──────────────────────────────────────────────────
        public bool IsConnected => _svc.IsConnected;
        public bool IsAuthenticated => _svc.IsAuthenticated;
        public bool SessionActive { get; private set; }
        /// <summary>True once the SDK stream is live (preview), independent of whether a DB session is recording.</summary>
        public bool IsStreaming => _streaming;
        public bool IsCapturing => _capturing;
        public DbUploader Db => _db;
        public long RawFrameCount => Interlocked.Read(ref _rawFrameCount);

        public string SessionId { get; private set; } = "";
        public string PairingCode { get; private set; } = "";
        /// <summary>When the session row was created/prepared (basis of the pairing code). NOT the recording start.</summary>
        public DateTime SessionStartUtc { get; private set; }
        /// <summary>When recording/upload actually began (Start pressed) — drives the REC timer.</summary>
        public DateTime RecordingStartUtc { get; private set; }
        /// <summary>Last-known sessions.sync_status (unclaimed/claimed/completed). Advisory, refreshed by poll.</summary>
        public string SyncStatus { get; private set; } = "";
        /// <summary>True once the unclaimed session row + pairing code have been created for this connection.</summary>
        public bool IsPrepared => _prepared;

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
                    HeartRate = _heartRate,
                    Spo2 = _spo2,
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
                // Begin live preview immediately so the technician can fit the headset and watch the
                // waveform BEFORE opening a DB session. Raw EEG unlocks once authentication completes;
                // signal-quality/impedance flow even pre-auth. DB upload stays gated behind StartSession.
                StartStreaming();
                // Post the unclaimed session row + pairing code now so the frontend can claim it
                // before the technician starts recording. No EEG is uploaded until StartSession.
                PrepareSession();
            };
            _svc.OnConnectionInterrupted += addr =>
            {
                // Transient link loss during a live connection (band slipped, BLE glitch). The SDK is
                // auto-reconnecting to the SAME device, so DO NOT tear anything down: keep _db, the
                // prepared/active session, session_id and pairing code intact so recording resumes into
                // the same session. No frames arrive while down — the raw pipeline stamps the missing
                // seconds as a normal resync gap. Flag streaming off so OnReconnected re-issues StartStream.
                _streaming = false;
                Log?.Invoke("[reconnect] link dropped — reconnecting, session preserved");
                ConnectionInterrupted?.Invoke();
            };
            _svc.OnReconnected += (addr, id) =>
            {
                // Link restored to the same device. Re-issue the SDK stream (raw EEG re-unlocks once the
                // device re-authenticates via OnMcu). Deliberately NO PrepareSession() — same session_id,
                // same _db, same pairing code; the recording simply continues.
                _connAddress = addr; _connDeviceID = id;
                Log?.Invoke("[reconnect] link restored — resuming session");
                StartStreaming();
                Reconnected?.Invoke();
            };
            _svc.OnDisconnected += addr =>
            {
                // Terminal disconnect: technician-initiated, or the reconnect budget was exhausted. If a
                // recording was active, flush + mark the session 'completed' so it closes cleanly rather
                // than dangling on 'recording' (StopSession is a no-op when nothing was recording). A later
                // reconnect re-arms the auto-preview + a fresh session prepare.
                if (SessionActive) StopSession();
                _streaming = false;
                SessionActive = false;
                StopSyncPoll();
                _prepared = false;
                SetSyncStatus("");
                lock (_stateLock) { _heartRate = null; _spo2 = null; }
                Disconnected?.Invoke(addr);
            };
            _svc.OnSignalReady += ready => { lock (_stateLock) _signalReady = ready; SignalStateChanged?.Invoke(); };
            _svc.OnChannelStatus += ch => { lock (_stateLock) _channels = ch; SignalStateChanged?.Invoke(); };
            _svc.OnImpedance += imp => { lock (_stateLock) _impedance = imp; SignalStateChanged?.Invoke(); };
            _svc.OnBattery += b => { lock (_stateLock) _battery = b; SignalStateChanged?.Invoke(); };
            _svc.OnSpo2HeartRate += v =>
            {
                if (v == null || v.Length < 2) return;
                // Delegate name order assumed [SpO2, heartRate]; ORDER + VALIDITY UNVERIFIED on hardware
                // (the Neeuro reference itself showed an implausible 23% SpO2). Swap indices here if HR/O2 read swapped.
                lock (_stateLock) { _spo2 = v[0]; _heartRate = v[1]; }
                SignalStateChanged?.Invoke();
            };
            _svc.OnRawEeg += HandleRawEeg;
            _svc.OnFilteredEeg += f => { lock (_stateLock) _lastFiltered = f; };
            _svc.OnFilteredEeg += f => _processor.AddFilteredFrame(f);
            _svc.OnFilteredEeg += UploadFilteredFrame;   // DB: full-res filtered µV → eeg_filtered_samples
            _svc.OnFilteredEeg += f =>   // TEMP: raw-vs-filtered capture (µV filtered stream)
            {
                if (!_rvfCapturing || f == null) return;
                // Filtered frames carry no SDK arrival stamp; capture now (in the marshalled handler).
                lock (_rvfLock) _rvfFilt.Add((DateTime.UtcNow, f));
            };
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

        /// <summary>Ends any active session, stops the live preview, then disconnects the device but
        /// keeps the app/SDK alive so the technician can scan/connect again. Fires <see cref="Disconnected"/>.</summary>
        public void Disconnect()
        {
            StopSession();
            StopSyncPoll();          // StopSession only stops it if recording; stop here for the preview-only case
            StopStreaming();
            _prepared = false;
            SetSyncStatus("");
            string addr = _connAddress;
            try { _svc.Disconnect(); } catch { /* ignore */ }
            // Fire explicitly so the UI resets even if the SDK's own disconnect callback doesn't.
            Disconnected?.Invoke(addr);
        }

        /// <summary>
        /// Starts the SDK stream for on-screen preview (waveform once authenticated, signal-quality/
        /// impedance immediately) WITHOUT opening a DB session. Called automatically on connect;
        /// idempotent and safe to call again. DB upload stays gated behind <see cref="StartSession"/>.
        /// </summary>
        public void StartStreaming()
        {
            if (_streaming || !_svc.IsConnected) return;
            _svc.StartStream();
            _streaming = true;
            StreamingChanged?.Invoke();
        }

        /// <summary>Stops the SDK stream, ending the live preview. Idempotent.</summary>
        public void StopStreaming()
        {
            if (!_streaming) return;
            _streaming = false;
            try { _svc.StopStream(); } catch { /* ignore */ }
            StreamingChanged?.Invoke();
        }

        /// <summary>
        /// Creates the unclaimed session row + pairing code and connects/anchors the DB clock —
        /// WITHOUT recording any EEG (that waits for <see cref="StartSession"/>). Called automatically
        /// on connect so the frontend can claim via the pairing code before the technician starts.
        /// Starts the advisory sync-status poll. Idempotent per prepared session.
        /// </summary>
        public void PrepareSession()
        {
            if (_prepared) return;
            _prepared = true;
            _recordingConfirmed = false;
            GenerateSession(_connAddress);   // local + instant: session_id + pairing code + created time
            SetSyncStatus("unclaimed");      // optimistic; the poll confirms/updates from the DB
            SessionPrepared?.Invoke();       // UI shows the pairing code immediately

            // The DB connect + INSERT is a cold TLS round-trip to the droplet. It MUST NOT run on the
            // caller's thread: on connect that's the SDK callback/UI thread, and blocking it for the
            // first (un-pooled) connection starved the BLE connect handshake and made early connects
            // fail until a retry warmed the pool. Run it off-thread; uploads stay gated behind Start.
            Task.Run(() =>
            {
                try
                {
                    if (StartDbUpload()) StartSyncPoll();   // connect + anchor + INSERT unclaimed row + flush timer
                }
                catch (Exception ex) { Log?.Invoke("[db] prepare failed: " + ex.Message); }
            });
        }

        /// <summary>
        /// Begins recording/upload for the prepared session — flips on the EEG/band/raw write gate.
        /// The session row + pairing code already exist from connect; this just opens the recording
        /// window. Preparation is retried here only if it never ran. Returns whether DB upload is live
        /// (false = recording locally only, e.g. DB unreachable).
        /// </summary>
        public bool StartSession()
        {
            StartStreaming();                  // no-op if the live preview is already running
            if (!_prepared) PrepareSession();  // safety net: connect-time prepare didn't run
            RecordingStartUtc = DateTime.UtcNow;
            SessionActive = true;
            SessionStarted?.Invoke();
            return _db != null && _db.Streaming;
        }

        /// <summary>
        /// Ends the recording window: flushes + closes the DB upload and marks the session
        /// 'completed', while LEAVING the live preview streaming and the device connected. Stops the
        /// sync-status poll. The disposed uploader is kept referenced so its final row counts stay
        /// visible; a fresh <see cref="StartSession"/> prepares a new session row + code. Idempotent.
        /// </summary>
        public void StopSession()
        {
            if (!SessionActive) return;
            SessionActive = false;
            StopSyncPoll();
            // Stop is the technician's explicit "complete session": flag the row so disposal flips
            // sessions.sync_status → 'completed' after the final data flush (unclaimed → claimed →
            // completed; the frontend owns the middle 'claimed' transition).
            try { _db?.RequestComplete(); } catch { /* ignore */ }
            try { _db?.Dispose(); } catch { /* ignore */ }
            _prepared = false;               // next Start prepares a new session row + pairing code
            _recordingConfirmed = false;
            SetSyncStatus("completed");
            SessionStopped?.Invoke();
        }

        private void GenerateSession(string bleAddress)
        {
            SessionStartUtc = DateTime.UtcNow;
            SessionId = Guid.NewGuid().ToString();
            PairingCode = BuildPairingCode(bleAddress, SessionStartUtc);
        }

        // ── Sync-status poll: reads sessions.sync_status and drives the coordinated-start
        //    handshake. ~1 s cadence so the web's Start/End is detected near-instantly; the read
        //    itself is non-blocking (Monitor.TryEnter) so it never contends with the write path. ──
        private void StartSyncPoll()
        {
            if (_syncPoll != null) return;
            _syncPoll = new Timer(_ => PollSyncStatus(), null, 1000, 1000);
        }

        private void StopSyncPoll()
        {
            try { _syncPoll?.Dispose(); } catch { /* ignore */ }
            _syncPoll = null;
        }

        private void PollSyncStatus()
        {
            var s = _db?.TryReadSyncStatus();
            if (string.IsNullOrEmpty(s)) return;
            SetSyncStatus(s);

            // Coordinated-start handshake (request → confirm). The frontend drives the lifecycle by
            // writing sync_status; the bridge reacts here. This is advisory display PLUS control, but
            // it still never gates the raw write path (that's behind SessionActive, set below).
            if (s == "recording" && !SessionActive)
            {
                // Web pressed "Start session" → auto-begin recording on this machine. No technician click.
                Log?.Invoke("[handshake] frontend requested recording → auto-starting session");
                StartSession();
            }
            else if (s == "completed" && SessionActive)
            {
                // Web ended the session → flush + close locally so both sides stop together.
                Log?.Invoke("[handshake] frontend ended session → auto-stopping session");
                StopSession();
                return;                       // poll is torn down by StopSession; nothing left to confirm
            }

            // Confirm to the frontend that EEG is actually flowing, once the upload is live. Idempotent
            // (DbUploader only writes bridge_recording_at while it's still NULL). Covers BOTH the auto
            // path above and a manual GUI Start — the web gates its first image on this timestamp, so it
            // can never show a stimulus before the bridge is recording. Retried each tick until it lands.
            if (SessionActive && !_recordingConfirmed && _db != null && _db.Streaming)
            {
                if (_db.MarkRecordingStarted()) _recordingConfirmed = true;
            }
        }

        private void SetSyncStatus(string status)
        {
            if (status == SyncStatus) return;
            SyncStatus = status;
            SyncStatusChanged?.Invoke();
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

            // TEMP raw-vs-filtered: capture the raw-float (µV) stream (a separate SDK callback from int).
            // ArrivalUtc is the SDK-synchronous delivery instant — same anchor the DB raw path uses.
            if (_rvfCapturing && frame.FloatSamples != null)
            {
                lock (_rvfLock) _rvfRaw.Add((frame.ArrivalUtc, frame.FloatSamples));
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

        // Streams the SDK's full-resolution filtered (µV) frames to eeg_filtered_samples, mirroring the
        // raw path. The frame is already a private per-frame clone (OnFiltered clones before dispatch), and
        // it carries no SDK arrival stamp — so DbNow at handler time anchors the per-sample counter clock.
        private void UploadFilteredFrame(float[] frame)
        {
            if (frame == null) return;
            // Local ref: StopSession may dispose _db on another thread mid-frame.
            var db = _db;
            if (SessionActive && db != null && db.Streaming)
                db.EnqueueFiltered(db.DbNow, frame);
        }

        private void UploadBandPowers(BandPowers[] powers)
        {
            if (!SessionActive || _db == null || !_db.Streaming) return;
            float att, rel, mwl; bool? ready; bool[] channels; int? hr, spo2;
            lock (_stateLock)
            {
                att = _sdkAttention; rel = _sdkRelaxation; mwl = _sdkMentalWorkload;
                ready = _signalReady; channels = _channels;
                hr = _heartRate; spo2 = _spo2;
            }
            _db.EnqueueBand(new BandPowerRow
            {
                Time = _db.DbNow,
                Attention = att,
                Relaxation = rel,
                MentalWorkload = mwl,
                SignalQuality = SignalQuality.Compute(ready, channels),
                HeartRate = hr,
                Spo2 = spo2,
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

        // ── TEMPORARY (client request): raw-vs-filtered comparison CSV ───────
        /// <summary>True while a raw-vs-filtered comparison capture is running.</summary>
        public bool IsRvfCapturing => _rvfCapturing;

        /// <summary>Starts capturing the SDK's raw-float (µV) and filtered (µV) streams for comparison.
        /// Frames only flow once the device is authenticated and streaming. TEMP — remove when done.</summary>
        public void StartRawVsFilteredCapture()
        {
            lock (_rvfLock) { _rvfRaw.Clear(); _rvfFilt.Clear(); }
            _rvfCapturing = true;
        }

        /// <summary>Stops the comparison capture and returns the (raw, filtered) frame counts. TEMP.</summary>
        public (int raw, int filt) StopRawVsFilteredCapture()
        {
            _rvfCapturing = false;
            lock (_rvfLock) return (_rvfRaw.Count, _rvfFilt.Count);
        }

        /// <summary>
        /// Writes one CSV pairing raw-float (µV) against SDK-filtered (µV) per channel, one row per
        /// sample. Frames are paired by arrival index (both streams derive from the same hardware feed).
        /// <para>
        /// sample_time_utc is a DB-style UNIFORM per-sample timestamp: anchored to the first raw frame's
        /// arrival, then advanced by 1/250 s per sample (same scheme as DbUploader.CopyRaw — BLE delivers
        /// frames in uneven bursts, so a uniform axis is truer than per-frame arrival). raw_arrival_utc /
        /// filt_arrival_utc expose each frame's actual arrival so the pairing/timeline can be verified.
        /// </para>
        /// Returns the path, or null if nothing was captured. TEMP — remove with the rest of the rvf capture.
        /// </summary>
        public string WriteRawVsFilteredCsv(string directory = null)
        {
            List<(DateTime A, float[] S)> raw, filt;
            lock (_rvfLock)
            {
                raw  = _rvfRaw.Select(x => (x.Arrival, x.Samples)).ToList();
                filt = _rvfFilt.Select(x => (x.Arrival, x.Samples)).ToList();
            }
            int pairs = Math.Min(raw.Count, filt.Count);
            if (pairs == 0) return null;

            // Uniform per-sample timeline at the true 250 Hz, anchored to the first raw frame's arrival
            // (= the time of that frame's LAST sample), exactly as the DB raw path anchors sample 0.
            long periodTicks = TimeSpan.TicksPerSecond / RvfSampleRateHz;
            int spc0 = raw[0].S.Length / ChannelCount;
            long baseTicks = raw[0].A.Ticks - (long)(spc0 - 1) * periodTicks;
            long gIdx = 0;   // running sample counter across frames

            const string TsFmt = "yyyy-MM-ddTHH:mm:ss.ffffffZ";   // µs precision, matches DB resolution

            string filename = $"rawvsfilt_{SessionId}_{DateTime.UtcNow:yyyyMMdd_HHmmss}.csv";
            string path = directory != null ? Path.Combine(directory, filename) : filename;

            using (var sw = new StreamWriter(path, false, Encoding.UTF8))
            {
                sw.Write("sample_time_utc,raw_arrival_utc,filt_arrival_utc,frame,sample_idx");
                foreach (var ch in ChannelLabels) sw.Write($",{ch}_raw_uV,{ch}_filt_uV");
                sw.WriteLine();

                for (int f = 0; f < pairs; f++)
                {
                    var (rArr, rs) = raw[f];
                    var (fArr, fs) = filt[f];
                    if (rs == null || fs == null || rs.Length < ChannelCount || fs.Length < ChannelCount) continue;

                    int rspc = rs.Length / ChannelCount;
                    int fspc = fs.Length / ChannelCount;
                    int spc  = Math.Min(rspc, fspc);
                    string rArrStr = rArr.ToUniversalTime().ToString(TsFmt, CultureInfo.InvariantCulture);
                    string fArrStr = fArr.ToUniversalTime().ToString(TsFmt, CultureInfo.InvariantCulture);
                    for (int s = 0; s < spc; s++)
                    {
                        var ts = new DateTime(baseTicks + (gIdx + s) * periodTicks, DateTimeKind.Utc);
                        sw.Write(ts.ToString(TsFmt, CultureInfo.InvariantCulture)); sw.Write(',');
                        sw.Write(rArrStr); sw.Write(','); sw.Write(fArrStr); sw.Write(',');
                        sw.Write(f);       sw.Write(','); sw.Write(s);
                        for (int ch = 0; ch < ChannelCount; ch++)
                        {
                            sw.Write(','); sw.Write(rs[ch * rspc + s].ToString("R", CultureInfo.InvariantCulture));
                            sw.Write(','); sw.Write(fs[ch * fspc + s].ToString("R", CultureInfo.InvariantCulture));
                        }
                        sw.WriteLine();
                    }
                    gIdx += spc;
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
            _streaming = false;
            StopSyncPoll();
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
        public int? HeartRate;
        public int? Spo2;
    }
}
