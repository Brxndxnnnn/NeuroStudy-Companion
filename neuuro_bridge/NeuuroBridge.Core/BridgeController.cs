using System;
using System.Collections.Generic;
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

        // Raw ADC integer counts -> microvolts. SenzeBand 2 product spec. Single shared source of
        // truth — NeuuroBridge.Wpf's LiveEegPanel scale-bar label uses this same constant rather
        // than keeping its own private copy.
        public const double MicrovoltsPerCount = 0.02235;

        /// <summary>
        /// Version of the running app — the WPF assembly's csproj &lt;Version&gt;. Stamped onto the
        /// session row so a stored dropout figure can be traced back to the build that produced it
        /// (drift tolerances are configurable, so "which bridge wrote this?" is a real question).
        /// Null under a test host with no entry assembly.
        /// </summary>
        public static string AppVersion =>
            System.Reflection.Assembly.GetEntryAssembly()?.GetName()?.Version?.ToString();

        private readonly SenzeBandService _svc = SenzeBandService.Instance;
        private readonly EegProcessor _processor = new EegProcessor();
        // ITP2 #4 — "Apply a low-pass filter with a cutoff frequency of 100 Hz to all EEG
        // signals before storage and analysis. Ensure filtering is consistently applied across
        // all acquisition channels." One instance per channel (ChannelLabels order), identical
        // coefficients (same cutoff/rate/order — that IS "consistently applied"), independent
        // state since each channel is its own signal. Built once for the controller's lifetime,
        // same convention as _processor above (EegProcessor is likewise never reset between
        // sessions) — a filter's brief settling transient after a reconnect is negligible.
        // Computed from HandleRawEeg's raw IntSamples, replacing the SDK's own onboard/vendor
        // filter (a black box with no documented cutoff) as the source for eeg_filtered_samples
        // AND everywhere else "filtered" is used (EegProcessor's FFT, live cache, CSV) — see
        // HandleRawEeg below.
        private readonly LowPassFilter[] _lowPass = ChannelLabels
            .Select(_ => new LowPassFilter(cutoffHz: 100.0, sampleRateHz: CaptureSampleRateHz))
            .ToArray();

        // ITP2 #5 — "EEG Signal Quality Checks... auto-detect + label on the EEG chart: Eye
        // Blink (transient/low-freq spike on Fp1/Fp2) and Teeth Clench (high-freq EMG on
        // T3/T4)." No specific algorithm/threshold was given in the requirement — these are
        // literature-reasonable starting heuristics, not clinically validated numbers; expect to
        // tune once real T3/T4 signal is available (electrodes flagged dead in project notes as
        // of writing). Live-chart annotation only, not persisted to the DB — see PushBlinkMarker/
        // PushClenchMarker in LiveEegPanel.xaml.cs.
        public event Action<DateTime> BlinkDetected;
        public event Action<DateTime> ClenchDetected;

        // Blink: fixed peak-amplitude threshold on the filtered Fp1/Fp2 signal. Blink amplitude
        // is a fairly device-independent physiological phenomenon (unlike EMG below) — a flat µV
        // cutoff is standard practice in EEG artifact-rejection literature.
        private const double BlinkThresholdUv = 100.0;
        private const int BlinkCooldownMs = 400; // one real blink can span several frames; collapse to one marker
        private DateTime _lastBlinkUtc = DateTime.MinValue;

        // Clench: adaptive threshold on T3/T4's existing Gamma-band power (EegProcessor already
        // computes this, 30-45Hz — squarely the EMG range), not a fixed number. Muscle-tension
        // baseline varies far more by individual and electrode contact than blink amplitude
        // does, so a flat threshold would be much more likely to be wrong. Same slow-EMA-baseline
        // approach LiveEegPanel's own auto-gain already uses (RecalibrateEegGain/BlendBaseline).
        private const double ClenchBaselineAlpha = 0.02; // slow blend -- tracks "resting" Gamma, not instantaneous spikes
        private const double ClenchMultiplier = 4.0;     // flag when current Gamma exceeds baseline by this factor
        private const int ClenchCooldownMs = 600;
        private const int ClenchMinBaselineSamples = 20; // ~5s at ~4Hz OnBandPowers rate -- skip until baseline means something
        private readonly double[] _gammaBaseline = new double[ChannelCount];
        private readonly int[] _gammaBaselineCount = new int[ChannelCount];
        private DateTime _lastClenchUtc = DateTime.MinValue;

        // Holds the faster-BLE-interval request for as long as a device is connected. Its log
        // messages go to the same sink as everything else, so a refused request is visible in the
        // session log rather than being silently absent.
        private readonly BleConnectionTuner _bleTuner;
        private DbUploader _db;

        private readonly object _devLock = new object();
        private readonly Dictionary<string, SenzeBandDeviceInfo> _devices = new Dictionary<string, SenzeBandDeviceInfo>();

        private readonly object _stateLock = new object();
        private long _rawFrameCount;
        private bool _streaming;
        private bool _prepared;                 // unclaimed session row + pairing code exist (created on connect)
        private bool _recordingConfirmed;       // bridge_recording_at written for the active session (handshake ack)
        private bool _recordingAnnounced;       // sync_status flipped to 'recording' for the active session
        private Timer _syncPoll;                // advisory poll of sessions.sync_status (read-only + lifecycle react)
        private Timer _progressPoll;            // advisory poll of web-side progress; outlives the recording (survey lands after)
        private Timer _summaryPoll;             // independent 2 Hz eeg_readings snapshot (see StartSummaryPoll)
        private Timer _eventsPoll;              // advisory poll of new session events (image/question/baseline markers)
        private int _progressBusy;              // 1 while a progress read is in flight (skip overlapping ticks)
        private int _eventsBusy;                // 1 while an events read is in flight (skip overlapping ticks)
        private DateTime _lastEventPollUtc;      // cursor: only fetch events with shown_at after this
        private string _dbConnString;           // cached for the progress poll (avoids re-reading .env every tick)
        private Guid _sessionGuid;
        private bool _draining;                 // Stop clicked; still accepting in-flight raw/filt/band frames (see StopGraceMs)
        private Timer _stopGraceTimer;           // one-shot; fires FinalizeStop after the drain window
        private long _tailLostSamples;           // raw samples rejected AFTER the drain window closed (see TailLossSeconds)
        // How long to keep accepting raw/filt/band frames after Stop before actually closing the
        // session out. BLE delivers frames in uneven bursts (see DbUploader's CopyRaw notes) — a
        // frame representing signal from BEFORE Stop was pressed can still be in flight and arrive
        // slightly after, and without this window it was silently dropped (observed ~4s tail on a
        // real session). Sized with margin over that observed worst case.
        private const int StopGraceMs = 4000;
        // Flat-line thresholds. A raw frame carries ~249 samples (~1 s), and live EEG shows a
        // within-frame peak-to-peak of ~180 ADC counts, so anything at or under a couple of
        // counts is not signal. Requiring several consecutive flat frames keeps a momentary
        // quiet patch from tripping the alarm while still catching a dead electrode in seconds.
        private const int FlatPkpkCounts = 2;
        private const int FlatFramesToDeclareDead = 3;
        // How much further past the drain window to keep attributing a rejected frame to "the
        // session that just stopped" (vs. unrelated later live-preview traffic) for TailLossSeconds.
        private const int TailTrackMarginMs = 2000;

        // Live snapshots (guarded by _stateLock).
        private int[] _lastRawInt;
        private float[] _lastFiltered;
        private float[,] _sdkAbdt;
        private float _sdkAttention = float.NaN, _sdkRelaxation = float.NaN, _sdkMentalWorkload = float.NaN;
        private BandPowers[] _fftPowers;
        // band_powers' primary key includes time. DbNow (DateTime.UtcNow) has coarse OS-timer
        // resolution (commonly ~15ms on Windows) — fine at the old ~1 Hz cadence, but the overlapping
        // FFT window (EegProcessor.FftStep) can complete more than one window from a single incoming
        // burst, firing OnBandPowers back-to-back with no real time elapsing between calls. Two such
        // calls can land in the same clock tick and collide on insert (23505 duplicate key). Track the
        // last timestamp actually used and force strict forward progress instead of trusting the OS
        // clock to always distinguish consecutive calls.
        private DateTime _lastBandDbTime;
        private bool? _signalReady;
        private bool[] _channels;
        private float[] _impedance;
        // Per-channel flat-line detection. The SDK's contact flags cannot be trusted on their
        // own: a railed electrode (constant ADC value, zero peak-to-peak) keeps reporting as
        // "connected", so a dead channel silently scored GOOD. Count consecutive flat frames
        // per channel and treat a channel as dead once it has not moved for a couple of them.
        private readonly int[] _flatFrames = new int[ChannelCount];
        private bool[] _channelLive;
        private string _battery;
        private int? _heartRate;
        private int? _spo2;

        // Session identity.
        private string _connAddress = "", _connDeviceID = "";
        private SenzeBandDeviceInfo _connDevice;

        // ── CSV capture (single combined export) ──────────────────────────────
        // Two parallel buffers, paired by arrival index at write time: the raw stream (int ADC +
        // float µV, each frame tagged with the last-known HR/SpO2/cognitive/quality at arrival) and
        // the filtered µV stream. One row per sample at the true 250 Hz with a uniform timestamp.
        private const int CaptureSampleRateHz = 250;   // true hardware rate (matches DbUploader)
        private volatile bool _capturing;
        private readonly List<CapFrame> _capRaw = new List<CapFrame>();
        private readonly List<(DateTime Arrival, float[] Samples)> _capFilt = new List<(DateTime, float[])>();
        private readonly object _captureLock = new object();

        // One captured raw frame plus the live values that were current when it arrived.
        private struct CapFrame
        {
            public DateTime Arrival;
            public long Frame;
            public int[] RawAdc;       // raw int ADC counts
            public float[] RawUv;      // raw float µV
            public int? Hr, Spo2;
            public float Att, Rel, Mwl;
            public int SignalQuality;
        }

        private bool _wired;

        // ── EEG stall watchdog ────────────────────────────────────────────────
        // A link can stay "connected" while the band stops sending EEG — no disconnect callback ever
        // fires, so nothing used to notice until the session's rows came up short. Raw frames arrive
        // about once a second, so several seconds of silence after authentication is a real stall.
        // The watchdog re-sends the stream start command a few times and tells the technician.
        private const double StallAfterSeconds = 5.0;
        private static readonly double[] StallRestartAtSeconds = { 5.0, 15.0, 30.0 };
        private Timer _stallWatchdog;
        private long _authOkTicks;              // when authentication last succeeded (stall clock starts here)
        private int _stallRestarts;
        private bool _stallReported;
        private double _stalledSeconds;

        /// <summary>Seconds since the band last delivered EEG while it should be streaming (0 = flowing).</summary>
        public double EegStalledSeconds => _stalledSeconds;
        /// <summary>True while a dropped link is being recovered.</summary>
        public bool IsReconnecting => _svc.IsReconnecting;
        /// <summary>How long the current link recovery has been running.</summary>
        public TimeSpan ReconnectElapsed => _svc.ReconnectElapsed;

        // ── Battery warnings ──────────────────────────────────────────────────
        // A band running flat is one of the likeliest causes of a mid-session drop. Each threshold is
        // logged once per connection as the level falls through it.
        public const int BatteryLowPercent = 20;
        public const int BatteryCriticalPercent = 10;
        private int _batteryWarnedAt = int.MaxValue;   // lowest threshold already warned about this connection

        /// <summary>Last battery level as a number, if the band has reported one that parses.</summary>
        public int? BatteryPercent { get; private set; }

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
        public event Action ProgressChanged;                 // web-side session progress advanced (see Progress)
        public event Action SessionStarted;                  // recording/upload began (Start pressed)
        public event Action SessionStopped;
        public event Action<RawEegFrame> RawFrame;           // every raw frame (for waveform charts)
        public event Action<BandPowers[]> FftBandPowers;     // ~1/s FFT result
        public event Action<List<SessionEventMarker>> SessionEvents;  // new image/question/baseline markers, advisory
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
        /// <summary>When recording last stopped; default until the first stop.</summary>
        public DateTime RecordingStopUtc { get; private set; }
        /// <summary>Recording window so far: live while recording, frozen at the last stop.
        /// Basis of the expected-row math on the DB upload panel.</summary>
        public TimeSpan RecordingElapsed
        {
            get
            {
                if (RecordingStartUtc == default(DateTime)) return TimeSpan.Zero;
                var end = SessionActive ? DateTime.UtcNow : RecordingStopUtc;
                return end > RecordingStartUtc ? end - RecordingStartUtc : TimeSpan.Zero;
            }
        }
        /// <summary>Seconds of raw signal that arrived just after the stop-grace window closed and
        /// was rejected — the rare case where <see cref="StopGraceMs"/> wasn't quite long enough to
        /// drain the in-flight BLE tail. Normally zero; surfaced separately (like the DbUploader's
        /// RawGapSeconds) so a residual is explained instead of silently absorbed into "expected."</summary>
        public double TailLossSeconds => Interlocked.Read(ref _tailLostSamples) / (double)CaptureSampleRateHz;
        /// <summary>Latest advisory snapshot of the web-side session flow (see <see cref="SessionProgress"/>).</summary>
        public SessionProgress Progress { get; private set; }
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
                    ChannelLive = _channelLive,
                    Impedance = _impedance,
                    Battery = _battery,
                    HeartRate = _heartRate,
                    Spo2 = _spo2,
                };
            }
        }

        // A constructor exists only because a field initialiser cannot capture `this`, and the
        // tuner needs to forward its messages to the Log event.
        public BridgeController()
        {
            _bleTuner = new BleConnectionTuner(m => Log?.Invoke(m));
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
                _batteryWarnedAt = int.MaxValue;   // a new connection warns about its own battery afresh
                StartStallWatchdog();
                Connected?.Invoke(addr, id);
                // Ask Windows for a faster BLE interval before any streaming begins. The default
                // ~30 ms interval carries ~32 of the ~40 notifications/s the headset wants to send,
                // and the vendor SDK amplifies each dropped notification into ~0.4 s of lost EEG.
                // Best-effort and off-thread — see BleConnectionTuner.
                _bleTuner.RequestThroughputAsync(addr, id);
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
                // The old link's parameter request died with it; re-request against the new one.
                _bleTuner.RequestThroughputAsync(addr, id);
                StartStreaming();
                Reconnected?.Invoke();
            };
            _svc.OnDisconnected += addr =>
            {
                // A disconnect callback can land LATE — after the technician has already reconnected
                // (the SDK resolving the OLD link's teardown after the NEW link is up). Acting on it
                // then would tear down the fresh session and leave the bridge recording nothing until a
                // restart. If the link is currently up, this callback is stale: drop it.
                if (_svc.IsConnected)
                {
                    Log?.Invoke("[reconnect] ignoring a stale disconnect for " + addr + " — link is up");
                    return;
                }
                // Terminal disconnect: technician-initiated, or the reconnect budget was exhausted. If a
                // recording was active, flush + mark the session 'completed' so it closes cleanly rather
                // than dangling on 'recording' (StopSession is a no-op when nothing was recording). A later
                // reconnect re-arms the auto-preview + a fresh session prepare.
                if (SessionActive) StopSession();
                // Device is gone — no more frames are coming, so there's no point waiting out the
                // rest of a drain window that just started (or was already in progress).
                if (_draining) FinalizeStop();
                _streaming = false;
                SessionActive = false;
                _svc.KeepReconnecting = false;
                StopStallWatchdog();
                StopSyncPoll();
                StopProgressPollUnlessSurveyPending();
                StopSummaryPoll();
                StopEventsPoll();
                // The link is gone; drop the parameter request so Windows is not holding a fast
                // interval open for a device that is no longer there.
                _bleTuner.Release();
                _prepared = false;
                SetSyncStatus("");
                lock (_stateLock) { _heartRate = null; _spo2 = null; }
                Disconnected?.Invoke(addr);
            };
            _svc.OnSignalReady += ready => { lock (_stateLock) _signalReady = ready; SignalStateChanged?.Invoke(); };
            _svc.OnChannelStatus += ch => { lock (_stateLock) _channels = ch; SignalStateChanged?.Invoke(); };
            _svc.OnImpedance += imp => { lock (_stateLock) _impedance = imp; SignalStateChanged?.Invoke(); };
            _svc.OnBattery += b => { lock (_stateLock) _battery = b; CheckBattery(b); SignalStateChanged?.Invoke(); };
            _svc.OnSpo2HeartRate += v =>
            {
                if (v == null || v.Length < 2) return;
                // Delegate name order assumed [SpO2, heartRate]; ORDER + VALIDITY UNVERIFIED on hardware
                // (the Neeuro reference itself showed an implausible 23% SpO2). Swap indices here if HR/O2 read swapped.
                lock (_stateLock) { _spo2 = v[0]; _heartRate = v[1]; }
                SignalStateChanged?.Invoke();
            };
            _svc.OnRawEeg += HandleRawEeg;
            // ITP2 #4: eeg_filtered_samples (and everywhere else "filtered" is used — FFT/band
            // powers, live cache, CSV) now comes from our own documented 100Hz low-pass
            // (HandleRawEeg -> ApplyLowPass), not the SDK's own onboard filter. OnFilteredEeg is
            // deliberately no longer consumed for any of this — see HandleRawEeg.
            _svc.OnAuthStatus += (ok, detail) =>
            {
                // EEG only flows once authenticated, so that is when the stall clock starts.
                Interlocked.Exchange(ref _authOkTicks, ok ? DateTime.UtcNow.Ticks : 0);
                AuthChanged?.Invoke(ok, detail);
            };

            _svc.OnAttention += v => { lock (_stateLock) _sdkAttention = v; SdkCognitiveChanged?.Invoke(); };
            _svc.OnRelaxation += v => { lock (_stateLock) _sdkRelaxation = v; SdkCognitiveChanged?.Invoke(); };
            _svc.OnMentalWorkload += v => { lock (_stateLock) _sdkMentalWorkload = v; SdkCognitiveChanged?.Invoke(); };
            _svc.OnAbdt += v => { lock (_stateLock) _sdkAbdt = v; SdkCognitiveChanged?.Invoke(); };

            _processor.OnBandPowers += powers => { lock (_stateLock) _fftPowers = powers; };
            _processor.OnBandPowers += UploadBandPowers;
            _processor.OnBandPowers += powers => FftBandPowers?.Invoke(powers);
            _processor.OnBandPowers += DetectClench;
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
            if (_draining) FinalizeStop();   // device is going away — don't wait out the rest of the drain window
            _svc.KeepReconnecting = false;   // the technician chose to end the link
            StopStallWatchdog();
            StopSyncPoll();          // StopSession only stops it if recording; stop here for the preview-only case
            StopProgressPollUnlessSurveyPending();   // see there: the survey outlives the BLE link
            StopSummaryPoll();
            StopEventsPoll();
            StopStreaming();
            _bleTuner.Release();
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
            _recordingAnnounced = false;
            // A new session replaces whatever survey a previous disconnected one was still waiting on.
            if (KeepsTrackingAfterDisconnect) StopProgressPoll();
            GenerateSession(_connAddress);   // local + instant: session_id + pairing code + created time
            SetSyncStatus("unclaimed");      // optimistic; the poll confirms/updates from the DB
            Progress = default(SessionProgress);   // fresh session — clear the last session's checklist
            ProgressChanged?.Invoke();
            SessionPrepared?.Invoke();       // UI shows the pairing code immediately

            // The DB connect + INSERT is a cold TLS round-trip to the droplet. It MUST NOT run on the
            // caller's thread: on connect that's the SDK callback/UI thread, and blocking it for the
            // first (un-pooled) connection starved the BLE connect handshake and made early connects
            // fail until a retry warmed the pool. Run it off-thread; uploads stay gated behind Start.
            Task.Run(() =>
            {
                // The DB can be transiently unreachable (cold TLS, brief network blip, a reconnect
                // racing the previous connection's teardown). Retry a few times with backoff before
                // giving up, so a momentary hiccup doesn't leave the session with no upload at all.
                const int attempts = 3;
                for (int i = 1; i <= attempts; i++)
                {
                    try
                    {
                        if (StartDbUpload()) { StartSyncPoll(); StartProgressPoll(); StartEventsPoll(); return; }
                        Log?.Invoke($"[db] prepare attempt {i}/{attempts} failed (DB unreachable) — retrying…");
                    }
                    catch (Exception ex) { Log?.Invoke($"[db] prepare attempt {i}/{attempts} error: {ex.Message}"); }
                    if (i < attempts) Thread.Sleep(1000 * i);
                }
                // Total failure: no session row / no upload. Live preview keeps running. Clear _prepared
                // so a later reconnect re-attempts a clean prepare rather than short-circuiting.
                _prepared = false;
                Log?.Invoke("[db] prepare FAILED after " + attempts + " attempts — recording is NOT live " +
                            "(no DB upload). Live preview continues; reconnect or check the DB/network.");
            });
        }

        /// <summary>
        /// Begins recording/upload for the prepared session — flips on the EEG/band/raw write gate.
        /// The session row + pairing code already exist from connect; this just opens the recording
        /// window. Preparation is retried here only if it never ran. This is the technician's "Start
        /// Session" press (client requirement #8: the bridge owns this transition, not the website) —
        /// makes a best-effort immediate write of sync_status='recording' via DbUploader.MarkRecording,
        /// with PollSyncStatus retrying every tick until it's confirmed (same pattern as
        /// bridge_recording_at/_recordingConfirmed below). Returns whether DB upload is live (false =
        /// recording locally only, e.g. DB unreachable).
        /// </summary>
        public bool StartSession()
        {
            StartStreaming();                  // no-op if the live preview is already running
            if (!_prepared) PrepareSession();  // safety net: connect-time prepare didn't run
            RecordingStartUtc = DateTime.UtcNow;
            RecordingStopUtc = default(DateTime);
            Interlocked.Exchange(ref _tailLostSamples, 0);
            SessionActive = true;
            // While recording, a lost band is retried until it comes back or the session is ended,
            // instead of the session being closed after a minute (see SenzeBandService.KeepReconnecting).
            _svc.KeepReconnecting = true;
            StartSummaryPoll();
            if (_db != null && _db.MarkRecording()) _recordingAnnounced = true;
            SessionStarted?.Invoke();
            return _db != null && _db.Streaming;
        }

        /// <summary>
        /// Ends the recording window. Freezes <see cref="RecordingElapsed"/> and flips the UI-facing
        /// <see cref="SessionActive"/> off immediately, but keeps accepting raw/filt/band frames for
        /// <see cref="StopGraceMs"/> more (see <see cref="_draining"/>) to drain whatever was still in
        /// flight over BLE when Stop was pressed, before <see cref="FinalizeStop"/> actually closes
        /// the DB upload out. Idempotent (a second call while draining/stopped is a no-op).
        /// </summary>
        public void StopSession()
        {
            if (!SessionActive) return;
            RecordingStopUtc = DateTime.UtcNow;   // freeze the recording window for expected-row math
            SessionActive = false;
            _svc.KeepReconnecting = false;        // no recording to protect any more: normal reconnect budget
            _draining = true;
            StopSyncPoll();
            StopSummaryPoll();
            // NOTE: the progress poll deliberately keeps running — the survey is submitted on the
            // web AFTER the session completes, and the checklist tracks through to that point.
            try { _stopGraceTimer?.Dispose(); } catch { /* ignore */ }
            _stopGraceTimer = new Timer(_ => FinalizeStop(), null, StopGraceMs, Timeout.Infinite);
        }

        /// <summary>
        /// Runs once, <see cref="StopGraceMs"/> after Stop (or immediately, if the device disconnects
        /// mid-drain — see <see cref="Disconnect"/>/OnDisconnected). Closes out what StopSession used
        /// to do synchronously: flush + close the DB upload and mark the session 'completed'. The
        /// disposed uploader is kept referenced so its final row counts stay visible. Idempotent.
        /// </summary>
        private void FinalizeStop()
        {
            if (!_draining) return;
            _draining = false;
            try { _stopGraceTimer?.Dispose(); } catch { /* ignore */ }
            _stopGraceTimer = null;
            // Stop is the technician's explicit "complete session": flag the row so disposal flips
            // sessions.sync_status → 'completed' after the final data flush (unclaimed → claimed →
            // completed; the frontend owns the middle 'claimed' transition).
            //
            // RecordingStopUtc and the app version go in here rather than being applied afterwards:
            // Dispose now owns the whole closing sequence (flush → seal trailing gap → write
            // diagnostics → mark completed) so every step runs on the one still-open connection and
            // in an order that cannot be got wrong from out here. Sealing the tail used to be a
            // separate call AFTER Dispose, which worked only because the connection happened to
            // still be reusable — and left no window to persist the corrected figures at all.
            try { _db?.RequestComplete(RecordingStopUtc, AppVersion); } catch { /* ignore */ }
            try { _db?.Dispose(); } catch { /* ignore */ }
            _prepared = false;               // next Start prepares a new session row + pairing code
            _recordingConfirmed = false;
            _recordingAnnounced = false;
            SetSyncStatus("completed");
            SessionStopped?.Invoke();
        }

        /// <summary>True while a raw frame arriving right now would still plausibly belong to the
        /// session that just stopped (drain window + a margin) — i.e. worth counting as tail loss
        /// rather than ordinary un-recorded live-preview traffic from whatever comes next.</summary>
        private bool IsWithinTailTrackWindow()
        {
            if (RecordingStopUtc == default(DateTime)) return false;
            return (DateTime.UtcNow - RecordingStopUtc).TotalMilliseconds <= StopGraceMs + TailTrackMarginMs;
        }

        private void GenerateSession(string bleAddress)
        {
            SessionStartUtc = DateTime.UtcNow;
            _sessionGuid = Guid.NewGuid();
            SessionId = _sessionGuid.ToString();
            PairingCode = BuildPairingCode(bleAddress, SessionStartUtc);
        }

        // ── Sync-status poll: reads sessions.sync_status and drives the coordinated-start
        //    handshake. ~1 s cadence so the web's Start/End is detected near-instantly; the read
        //    itself is non-blocking (Monitor.TryEnter) so it never contends with the write path. ──
        // ── EEG stall watchdog (see the field notes) ──
        private void StartStallWatchdog()
        {
            _stallRestarts = 0;
            _stallReported = false;
            _stalledSeconds = 0;
            if (_stallWatchdog != null) return;
            _stallWatchdog = new Timer(_ => CheckStall(), null, 1000, 1000);
        }

        private void StopStallWatchdog()
        {
            try { _stallWatchdog?.Dispose(); } catch { /* ignore */ }
            _stallWatchdog = null;
            _stalledSeconds = 0;
        }

        private void CheckStall()
        {
            try
            {
                // Only meaningful while the link is up, authenticated and supposed to be streaming. A
                // reconnect has its own handling and UI; before authentication no EEG is expected.
                long authTicks = Interlocked.Read(ref _authOkTicks);
                if (!_svc.IsConnected || _svc.IsReconnecting || !_svc.IsAuthenticated || !_streaming || authTicks == 0)
                {
                    _stalledSeconds = 0;
                    return;
                }

                long lastTicks = Math.Max(_svc.LastRawArrivalUtc.Ticks, authTicks);
                double silent = (DateTime.UtcNow.Ticks - lastTicks) / (double)TimeSpan.TicksPerSecond;
                if (silent < StallAfterSeconds)
                {
                    if (_stallReported)
                        Log?.Invoke($"[watchdog] EEG is arriving again (stopped for {_stalledSeconds:F0} s).");
                    _stallReported = false;
                    _stallRestarts = 0;
                    _stalledSeconds = 0;
                    return;
                }

                _stalledSeconds = silent;
                if (!_stallReported)
                {
                    _stallReported = true;
                    Log?.Invoke($"[watchdog] No EEG from the band for {silent:F0} s although it is connected" +
                                (SessionActive ? " — this part of the recording is being lost." : ".") +
                                " Check the band is worn and switched on.");
                }
                if (_stallRestarts < StallRestartAtSeconds.Length && silent >= StallRestartAtSeconds[_stallRestarts])
                {
                    _stallRestarts++;
                    _svc.RestartStream();
                }
            }
            catch { /* advisory: never let the watchdog take the bridge down */ }
        }

        private void CheckBattery(string reported)
        {
            if (!double.TryParse(reported?.Trim().TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out var pct))
                return;
            int level = (int)Math.Round(pct);
            BatteryPercent = level;
            int threshold = level <= BatteryCriticalPercent ? BatteryCriticalPercent
                          : level <= BatteryLowPercent ? BatteryLowPercent : int.MaxValue;
            if (threshold >= _batteryWarnedAt) return;
            _batteryWarnedAt = threshold;
            Log?.Invoke(threshold == BatteryCriticalPercent
                ? $"WARNING: band battery critical ({level}%) — it may switch off mid-session. Charge it before recording."
                : $"WARNING: band battery low ({level}%) — charge it before the next session.");
        }

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

        // ── Summary snapshot: a genuine independent 2 Hz timer, NOT piggybacked on raw-frame
        //    arrival. It previously rode inside HandleRawEeg gated by a Stopwatch, but BLE delivers
        //    raw callbacks in uneven bursts (see CopyRaw's notes), so that throttle only got a chance
        //    to fire as often as a callback happened to land — capping real throughput at roughly the
        //    burst cadence (~1/s observed) instead of the intended 2/s, and made "expected" row counts
        //    on the DB panel look like a shortfall when nothing was actually lost. ──
        private void StartSummaryPoll()
        {
            if (_summaryPoll != null) return;
            _summaryPoll = new Timer(_ => PollSummary(), null, 500, 500);
        }

        private void StopSummaryPoll()
        {
            try { _summaryPoll?.Dispose(); } catch { /* ignore */ }
            _summaryPoll = null;
        }

        private void PollSummary()
        {
            if (!SessionActive || _db == null || !_db.Streaming) return;
            UploadEegSnapshot();
        }

        private void PollSyncStatus()
        {
            var s = _db?.TryReadSyncStatus();
            if (string.IsNullOrEmpty(s)) return;
            SetSyncStatus(s);

            // Coordinated-END handshake only — the website still owns ending a session (writes
            // sync_status='completed'); the bridge reacts by draining and closing locally so both
            // sides stop together. Starting is the OPPOSITE direction now (client requirement #8):
            // the technician presses Start here, StartSession() writes 'recording' itself, and the
            // website just observes it — there is no "web wrote recording, auto-start" branch anymore.
            if (s == "completed" && SessionActive)
            {
                Log?.Invoke("[handshake] frontend ended session → auto-stopping session");
                StopSession();
                return;                       // poll is torn down by StopSession; nothing left to confirm
            }

            // Retry the two Start confirmations every tick until each lands — non-blocking writes,
            // so a slow/contended flush just means "try again next second," not a stall.
            if (SessionActive && !_recordingAnnounced && _db != null)
            {
                if (_db.MarkRecording()) _recordingAnnounced = true;
            }
            // Confirm to the frontend that EEG is actually flowing, once the upload is live. Idempotent
            // (DbUploader only writes bridge_recording_at while it's still NULL) — the web gates its
            // first image on this timestamp, so it can never show a stimulus before the bridge records.
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

        // ── Progress poll: advisory read of how far the web-side flow has gone (paired → recording
        //    → images → math questions → ended → survey submitted). Runs on its own pooled
        //    connection so it never touches the write path, and DELIBERATELY survives StopSession —
        //    the questionnaire is submitted on the web after the session completes. Stops itself
        //    once the journey is complete, or with the connection. ──
        private void StartProgressPoll()
        {
            if (_progressPoll != null) return;
            _progressPoll = new Timer(_ => PollProgress(), null, 1500, 2000);
        }

        private void StopProgressPoll()
        {
            try { _progressPoll?.Dispose(); } catch { /* ignore */ }
            _progressPoll = null;
            KeepsTrackingAfterDisconnect = false;
        }

        // How long after a disconnect the progress poll keeps waiting for the questionnaires.
        private static readonly TimeSpan SurveyWaitAfterDisconnect = TimeSpan.FromMinutes(30);
        private DateTime _surveyWaitUntilUtc;

        /// <summary>True while the bridge is still watching the database for the technician's
        /// questionnaires even though the band has disconnected (see
        /// <see cref="StopProgressPollUnlessSurveyPending"/>). The UI keeps the checklist and the scores
        /// panel on screen instead of clearing them.</summary>
        public bool KeepsTrackingAfterDisconnect { get; private set; }

        // The band can drop (idle timeout, reconnect budget spent) while the technician is still
        // answering the website's questionnaires, which happens after recording ends. The questionnaire
        // progress and scores come from the database, not the band, so a claimed session whose survey
        // isn't finished keeps its poll for a while; it stops itself once everything is answered, after
        // the wait above, or when the next session is prepared.
        private void StopProgressPollUnlessSurveyPending()
        {
            var p = Progress;
            if (_progressPoll != null && p.Claimed && !p.SurveySubmitted)
            {
                KeepsTrackingAfterDisconnect = true;
                _surveyWaitUntilUtc = DateTime.UtcNow + SurveyWaitAfterDisconnect;
                Log?.Invoke("[progress] band disconnected — still watching the database for the questionnaires");
                return;
            }
            StopProgressPoll();
        }

        private void PollProgress()
        {
            if (Interlocked.Exchange(ref _progressBusy, 1) == 1) return;   // previous read still in flight
            try
            {
                if (_sessionGuid == Guid.Empty || _dbConnString == null) return;
                var p = DbUploader.TryReadProgress(_dbConnString, _sessionGuid);
                if (!p.Known) return;
                var old = Progress;
                Progress = p;
                if (old.Claimed != p.Claimed || old.RecordingConfirmed != p.RecordingConfirmed ||
                    old.ImagesShown != p.ImagesShown || old.QuestionsShown != p.QuestionsShown ||
                    old.Ended != p.Ended || old.SurveySubmitted != p.SurveySubmitted ||
                    old.AnsweredTotal != p.AnsweredTotal)
                {
                    if (!old.Claimed && p.Claimed) Log?.Invoke("[progress] paired with website");
                    if (!old.RecordingConfirmed && p.RecordingConfirmed) Log?.Invoke("[progress] recording confirmed to website");
                    if (!old.ImagesShown && p.ImagesShown) Log?.Invoke("[progress] website is showing images");
                    if (!old.QuestionsShown && p.QuestionsShown) Log?.Invoke("[progress] website is showing math questions");
                    if (!old.Ended && p.Ended) Log?.Invoke("[progress] session ended on website");
                    if (old.AnsweredTotal != p.AnsweredTotal && !p.SurveySubmitted) Log?.Invoke("[progress] questionnaire answers received (" + p.AnsweredTotal + " items so far)");
                    if (!old.SurveySubmitted && p.SurveySubmitted) Log?.Invoke("[progress] all questionnaires submitted — scores read from DB");
                    ProgressChanged?.Invoke();
                }
                if (KeepsTrackingAfterDisconnect && DateTime.UtcNow > _surveyWaitUntilUtc)
                {
                    Log?.Invoke("[progress] gave up waiting for the questionnaires after the band disconnected");
                    StopProgressPoll();
                    return;
                }
                if (p.Ended && p.SurveySubmitted)
                {
                    Log?.Invoke("[progress] session journey complete — progress tracking stopped");
                    StopProgressPoll();
                }
            }
            catch { /* advisory only */ }
            finally { Interlocked.Exchange(ref _progressBusy, 0); }
        }

        // ── Events poll: advisory read of new session events (image/question shown, baseline/countdown
        //    phase markers) for live-chart annotation. Own pooled connection, same reasoning as the
        //    progress poll. Cursor-based (shown_at > last seen) so each tick only fetches what's new. ──
        private void StartEventsPoll()
        {
            if (_eventsPoll != null) return;
            _lastEventPollUtc = SessionStartUtc > default(DateTime) ? SessionStartUtc.AddSeconds(-1) : DateTime.UtcNow.AddSeconds(-1);
            _eventsPoll = new Timer(_ => PollEvents(), null, 1000, 1000);
        }

        private void StopEventsPoll()
        {
            try { _eventsPoll?.Dispose(); } catch { /* ignore */ }
            _eventsPoll = null;
        }

        private void PollEvents()
        {
            if (Interlocked.Exchange(ref _eventsBusy, 1) == 1) return;   // previous read still in flight
            try
            {
                if (_sessionGuid == Guid.Empty || _dbConnString == null) return;
                var found = DbUploader.TryReadNewEvents(_dbConnString, _sessionGuid, _lastEventPollUtc);
                if (found.Count == 0) return;
                foreach (var m in found)
                    if (m.ShownAtUtc > _lastEventPollUtc) _lastEventPollUtc = m.ShownAtUtc;
                SessionEvents?.Invoke(found);
            }
            catch { /* advisory only */ }
            finally { Interlocked.Exchange(ref _eventsBusy, 0); }
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
            _dbConnString = EnvConfig.BuildConnectionString();
            // Build into a LOCAL and only publish to _db once it is fully connected AND the session row
            // exists. The old code assigned _db before Connect(), so a failed/retried prepare left _db
            // pointing at a dead, non-streaming uploader; a failed attempt now disposes cleanly instead.
            var db = new DbUploader(_dbConnString, m => Log?.Invoke("[db] " + m));
            if (!db.Connect())
            {
                try { db.Dispose(); } catch { /* ignore */ }
                return false;
            }
            int sampleRate = EegProcessor.SampleRate == 125 ? 125 : 250;
            if (!db.CreateSession(Guid.Parse(SessionId), _connAddress, PairingCode, sampleRate, SessionStartUtc))
            {
                try { db.Dispose(); } catch { /* ignore */ }
                return false;
            }
            _db = db;
            return true;
        }

        // ── SDK raw frame handling (mirrors the console path) ────────────────
        private void HandleRawEeg(RawEegFrame frame)
        {
            if (frame.IntSamples != null)
            {
                Interlocked.Increment(ref _rawFrameCount);
                lock (_stateLock)
                {
                    _lastRawInt = frame.IntSamples;
                    UpdateChannelLiveness(frame.IntSamples);
                }

                // Capture a local ref: StopSession may dispose _db on another thread mid-frame.
                var db = _db;
                if ((SessionActive || _draining) && db != null && db.Streaming)
                    db.EnqueueRaw(db.ToDbTime(frame.ArrivalUtc), frame.IntSamples);
                else if (IsWithinTailTrackWindow())
                    Interlocked.Add(ref _tailLostSamples, frame.IntSamples.Length / ChannelCount);

                // ITP2 #4 — our own 100Hz low-pass, replacing the SDK's onboard filter as the
                // single source for "filtered" everywhere: DB storage, FFT/band-power analysis,
                // the live-display cache, and CSV capture. Same raw sample stream/timing already
                // used for eeg_raw_samples above, just run through ApplyLowPass first.
                float[] filtered = ApplyLowPass(frame.IntSamples);
                lock (_stateLock) _lastFiltered = filtered;
                _processor.AddFilteredFrame(filtered);
                UploadFilteredFrame(filtered, frame.ArrivalUtc);
                if (_capturing) lock (_captureLock) _capFilt.Add((DateTime.UtcNow, filtered));
                DetectBlink(filtered);
            }

            // Combined CSV capture: record raw ADC + raw µV for this frame, tagged with the
            // last-known vitals/cognitive. ArrivalUtc is the SDK-synchronous delivery instant.
            if (_capturing) CaptureRawFrame(frame);

            RawFrame?.Invoke(frame);
        }

        /// <summary>Converts raw ADC counts to µV and runs each channel through its own 100Hz
        /// low-pass (see the _lowPass field comment). Block layout in, block layout out —
        /// [ch0][ch1][ch2][ch3] — identical to what the SDK's own filtered frames used, so every
        /// downstream consumer (EegProcessor, DbUploader, CSV capture) needs no changes beyond
        /// what feeds them.</summary>
        private float[] ApplyLowPass(int[] rawSamples)
        {
            int spc = rawSamples.Length / ChannelCount;
            var filtered = new float[rawSamples.Length];
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                var filter = _lowPass[ch];
                int baseIdx = ch * spc;
                for (int i = 0; i < spc; i++)
                {
                    float uv = (float)(rawSamples[baseIdx + i] * MicrovoltsPerCount);
                    filtered[baseIdx + i] = filter.Process(uv);
                }
            }
            return filtered;
        }

        /// <summary>ITP2 #5 — flags a transient eye-blink artifact when either frontal channel's
        /// filtered signal peaks above BlinkThresholdUv within this frame. Checked on every raw
        /// frame (same cadence as ApplyLowPass), cooldown-gated so one real blink — which can
        /// span several consecutive frames while amplitude stays elevated — produces one marker,
        /// not a flooded cluster.</summary>
        private void DetectBlink(float[] filtered)
        {
            int spc = filtered.Length / ChannelCount;
            if (spc == 0) return;
            float peak = 0;
            for (int ch = 0; ch <= 1; ch++) // Fp1, Fp2 — frontal channels only
            {
                int baseIdx = ch * spc;
                // Measure the deflection from this frame's own baseline, not from zero. The filtered
                // stream is a low-pass of the raw signal and keeps the electrode's DC offset, so an
                // absolute threshold fired on the offset rather than on blinks.
                double mean = 0;
                for (int i = 0; i < spc; i++) mean += filtered[baseIdx + i];
                mean /= spc;
                for (int i = 0; i < spc; i++)
                {
                    float abs = (float)Math.Abs(filtered[baseIdx + i] - mean);
                    if (abs > peak) peak = abs;
                }
            }
            if (peak < BlinkThresholdUv) return;

            DateTime now = DateTime.UtcNow;
            if ((now - _lastBlinkUtc).TotalMilliseconds < BlinkCooldownMs) return;
            _lastBlinkUtc = now;
            BlinkDetected?.Invoke(now);
        }

        /// <summary>ITP2 #5 — flags a teeth-clench/EMG artifact when either temporal channel's
        /// Gamma band power (EegProcessor already computes this, 30-45Hz — squarely the EMG
        /// range) exceeds a slow-moving per-channel baseline by ClenchMultiplier. Adaptive rather
        /// than a fixed power number, since muscle-tension baseline varies far more by
        /// individual/electrode contact than blink amplitude does (see DetectBlink). Same
        /// cooldown reasoning as blink: a held contraction shouldn't flood one marker per
        /// ~256ms band-power update.</summary>
        private void DetectClench(BandPowers[] powers)
        {
            bool triggered = false;
            for (int ch = 2; ch <= 3; ch++) // T4, T3 — temporal channels only
            {
                double gamma = powers[ch].Gamma;
                double baseline = _gammaBaseline[ch];

                if (_gammaBaselineCount[ch] < ClenchMinBaselineSamples)
                {
                    // Still establishing a baseline — blend in but don't detect against it yet
                    // (an unestablished baseline of 0 would trivially "exceed" on sample one).
                    _gammaBaseline[ch] = _gammaBaselineCount[ch] == 0
                        ? gamma
                        : baseline * (1 - ClenchBaselineAlpha) + gamma * ClenchBaselineAlpha;
                    _gammaBaselineCount[ch]++;
                    continue;
                }

                if (baseline > 0 && gamma > baseline * ClenchMultiplier)
                    triggered = true;

                // Blend AFTER the comparison — a genuine clench shouldn't drag its own baseline up.
                _gammaBaseline[ch] = baseline * (1 - ClenchBaselineAlpha) + gamma * ClenchBaselineAlpha;
            }

            if (!triggered) return;

            DateTime now = DateTime.UtcNow;
            if ((now - _lastClenchUtc).TotalMilliseconds < ClenchCooldownMs) return;
            _lastClenchUtc = now;
            ClenchDetected?.Invoke(now);
        }

        private void UploadEegSnapshot()
        {
            var db = _db;   // _db may be disposed/replaced on another thread mid-call
            if (db == null || !db.Streaming) return;

            int[] raw; float[] filt;
            lock (_stateLock) { raw = _lastRawInt; filt = _lastFiltered; }
            if (raw == null && filt == null) return;

            var row = new EegReadingRow
            {
                Time = db.DbNow,
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
            db.EnqueueEeg(row);
        }

        // Streams our own 100Hz-low-pass-filtered (µV) frames to eeg_filtered_samples (see
        // ApplyLowPass), mirroring the raw path. The array is a fresh per-call allocation (not
        // shared/mutated elsewhere).
        //
        // Stamped with the SOURCE raw frame's arrival time, exactly like the raw stream. It used to
        // take DbNow at handler time, but handlers run wherever the SDK's callbacks are marshalled
        // (the UI thread in the WPF app), so any UI stall longer than the filtered drift tolerance
        // (700 ms) made this stream record a gap that never happened and shifted everything after it
        // later than the image/question events — on the very stream ml_service trains on.
        private void UploadFilteredFrame(float[] frame, DateTime arrivalUtc)
        {
            if (frame == null) return;
            // Local ref: StopSession may dispose _db on another thread mid-frame.
            var db = _db;
            if ((SessionActive || _draining) && db != null && db.Streaming)
                db.EnqueueFiltered(db.ToDbTime(arrivalUtc), frame);
        }

        private void UploadBandPowers(BandPowers[] powers)
        {
            var db = _db;   // capture once — _db may be disposed/replaced on another thread mid-call
            if (!(SessionActive || _draining) || db == null || !db.Streaming) return;
            float att, rel, mwl; bool? ready; bool[] channels; bool[] live; int? hr, spo2;
            lock (_stateLock)
            {
                att = _sdkAttention; rel = _sdkRelaxation; mwl = _sdkMentalWorkload;
                ready = _signalReady; channels = _channels; live = _channelLive;
                hr = _heartRate; spo2 = _spo2;
            }
            // Force strict forward progress — see _lastBandDbTime. The expected inter-row spacing
            // (1 / BandRowsPerSecond) is the right fallback step when the OS clock doesn't resolve
            // two back-to-back calls: it's exactly how far apart these windows really are.
            DateTime t = db.DbNow;
            if (t <= _lastBandDbTime)
                t = _lastBandDbTime.AddSeconds(1.0 / DbUploader.BandRowsPerSecond);
            _lastBandDbTime = t;

            db.EnqueueBand(new BandPowerRow
            {
                Time = t,
                Attention = att,
                Relaxation = rel,
                MentalWorkload = mwl,
                SignalQuality = SignalQuality.Compute(ready, channels, live),
                HeartRate = hr,
                Spo2 = spo2,
                Bands = powers,
            });
        }

        // ── CSV capture (single combined export) ─────────────────────────────
        public void StartCapture()
        {
            lock (_captureLock) { _capRaw.Clear(); _capFilt.Clear(); }
            _capturing = true;
        }

        /// <summary>Stops capturing and returns the number of raw frames buffered.</summary>
        public int StopCapture()
        {
            _capturing = false;
            lock (_captureLock) return _capRaw.Count;
        }

        private void CaptureRawFrame(RawEegFrame frame)
        {
            int? hr, spo2; float att, rel, mwl; bool? ready; bool[] channels;
            lock (_stateLock)
            {
                hr = _heartRate; spo2 = _spo2;
                att = _sdkAttention; rel = _sdkRelaxation; mwl = _sdkMentalWorkload;
                ready = _signalReady; channels = _channels;
            }
            var rec = new CapFrame
            {
                Arrival = frame.ArrivalUtc,
                Frame = Interlocked.Read(ref _rawFrameCount),
                RawAdc = frame.IntSamples != null ? (int[])frame.IntSamples.Clone() : null,
                RawUv = frame.FloatSamples != null ? (float[])frame.FloatSamples.Clone() : null,
                Hr = hr, Spo2 = spo2, Att = att, Rel = rel, Mwl = mwl,
                SignalQuality = SignalQuality.Compute(ready, channels),
            };
            lock (_captureLock) _capRaw.Add(rec);
        }

        /// <summary>
        /// Writes one combined CSV: per channel the raw ADC, raw µV and SDK-filtered µV, plus the
        /// last-known heart rate, SpO₂, attention, relaxation, mental workload and signal quality —
        /// one row per sample. Raw and filtered frames are paired by arrival index (both derive from
        /// the same hardware feed). sample_time_utc is a uniform 250 Hz axis anchored to the first
        /// frame's arrival (matching DbUploader.CopyRaw); arrival_utc exposes each frame's raw arrival.
        /// Returns the path, or null if nothing was captured.
        /// </summary>
        public string WriteCsv(string directory = null)
        {
            List<CapFrame> raw; List<(DateTime A, float[] S)> filt;
            lock (_captureLock)
            {
                raw = new List<CapFrame>(_capRaw);
                filt = new List<(DateTime, float[])>(_capFilt);
            }
            if (raw.Count == 0) return null;

            // Uniform per-sample timeline at the true 250 Hz, anchored to the first raw frame's arrival
            // (= the time of that frame's LAST sample), exactly as the DB raw path anchors sample 0.
            long periodTicks = TimeSpan.TicksPerSecond / CaptureSampleRateHz;
            int spc0 = FrameSpc(raw[0]);
            if (spc0 <= 0) return null;
            long baseTicks = raw[0].Arrival.Ticks - (long)(spc0 - 1) * periodTicks;
            long gIdx = 0;   // running sample counter across frames

            const string TsFmt = "yyyy-MM-ddTHH:mm:ss.ffffffZ";   // µs precision, matches DB resolution

            string filename = $"capture_{SessionId}_{DateTime.UtcNow:yyyyMMdd_HHmmss}.csv";
            string path = directory != null ? Path.Combine(directory, filename) : filename;

            using (var sw = new StreamWriter(path, false, Encoding.UTF8))
            {
                sw.Write("sample_time_utc,arrival_utc,frame,sample_idx");
                foreach (var ch in ChannelLabels) sw.Write($",{ch}_raw_adc,{ch}_raw_uV,{ch}_filt_uV");
                sw.WriteLine(",heart_rate,spo2,attention,relaxation,mental_workload,signal_quality");

                for (int f = 0; f < raw.Count; f++)
                {
                    var r = raw[f];
                    float[] fs = f < filt.Count ? filt[f].S : null;
                    int adcSpc = r.RawAdc != null ? r.RawAdc.Length / ChannelCount : 0;
                    int uvSpc  = r.RawUv  != null ? r.RawUv.Length  / ChannelCount : 0;
                    int filtSpc = fs != null ? fs.Length / ChannelCount : 0;
                    int spc = Math.Max(adcSpc, Math.Max(uvSpc, filtSpc));
                    if (spc == 0) continue;

                    string arr = r.Arrival.ToUniversalTime().ToString(TsFmt, CultureInfo.InvariantCulture);
                    string hr  = r.Hr?.ToString(CultureInfo.InvariantCulture) ?? "";
                    string spo = r.Spo2?.ToString(CultureInfo.InvariantCulture) ?? "";
                    string att = FmtF(r.Att), rel = FmtF(r.Rel), mwl = FmtF(r.Mwl);
                    string sq  = r.SignalQuality.ToString(CultureInfo.InvariantCulture);

                    for (int s = 0; s < spc; s++)
                    {
                        var ts = new DateTime(baseTicks + (gIdx + s) * periodTicks, DateTimeKind.Utc);
                        sw.Write(ts.ToString(TsFmt, CultureInfo.InvariantCulture)); sw.Write(',');
                        sw.Write(arr); sw.Write(','); sw.Write(r.Frame); sw.Write(','); sw.Write(s);
                        for (int ch = 0; ch < ChannelCount; ch++)
                        {
                            sw.Write(',');
                            if (s < adcSpc) sw.Write(r.RawAdc[ch * adcSpc + s]);
                            sw.Write(',');
                            if (s < uvSpc) sw.Write(r.RawUv[ch * uvSpc + s].ToString("R", CultureInfo.InvariantCulture));
                            sw.Write(',');
                            if (s < filtSpc) sw.Write(fs[ch * filtSpc + s].ToString("R", CultureInfo.InvariantCulture));
                        }
                        sw.Write(','); sw.Write(hr);
                        sw.Write(','); sw.Write(spo);
                        sw.Write(','); sw.Write(att);
                        sw.Write(','); sw.Write(rel);
                        sw.Write(','); sw.Write(mwl);
                        sw.Write(','); sw.Write(sq);
                        sw.WriteLine();
                    }
                    gIdx += spc;
                }
            }
            return Path.GetFullPath(path);
        }

        private static int FrameSpc(CapFrame r)
        {
            if (r.RawAdc != null) return r.RawAdc.Length / ChannelCount;
            if (r.RawUv != null) return r.RawUv.Length / ChannelCount;
            return 0;
        }

        private static string FmtF(float v) => float.IsNaN(v) ? "" : v.ToString("0.###", CultureInfo.InvariantCulture);

        /// <summary>
        /// Updates the per-channel flat-line state from one raw frame. Caller holds _stateLock.
        /// A channel is declared dead after <see cref="FlatFramesToDeclareDead"/> consecutive
        /// frames with essentially no peak-to-peak movement, and revives the instant it moves.
        /// </summary>
        private void UpdateChannelLiveness(int[] rawFrame)
        {
            var live = _channelLive ?? new bool[ChannelCount];
            for (int ch = 0; ch < ChannelCount; ch++)
            {
                var s = IntLastPkpk(rawFrame, ch);
                if (s.pkpk <= FlatPkpkCounts)
                {
                    if (_flatFrames[ch] < int.MaxValue) _flatFrames[ch]++;
                }
                else
                {
                    _flatFrames[ch] = 0;
                }
                live[ch] = _flatFrames[ch] < FlatFramesToDeclareDead;
            }
            _channelLive = live;
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
            StopStallWatchdog();
            StopSyncPoll();
            StopProgressPoll();
            StopSummaryPoll();
            StopEventsPoll();
            if (_draining) FinalizeStop();   // app shutting down — don't leave a grace timer dangling
            try { _svc.StopStream(); } catch { /* ignore */ }
            try { _db?.Dispose(); } catch { /* ignore */ }
            try { _bleTuner.Dispose(); } catch { /* ignore */ }
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
        /// <summary>Per-electrode liveness: false where the channel has flat-lined (railed ADC).</summary>
        public bool[] ChannelLive;
        public bool[] Channels;
        public float[] Impedance;
        public string Battery;
        public int? HeartRate;
        public int? Spo2;
    }
}
