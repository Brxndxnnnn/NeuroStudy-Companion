using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using NeeuroOSWindows;

namespace NeuuroBridge
{
    /// <summary>A SenzeBand discovered during a BLE scan.</summary>
    public class SenzeBandDeviceInfo
    {
        public string DeviceID { get; set; }
        public string DeviceName { get; set; }
        public string DeviceAddress { get; set; }
        public bool IsConnected { get; set; }
        public bool CanPair { get; set; }
        public bool IsEnabled { get; set; }
    }

    /// <summary>
    /// One 0.2 s package (50 samples per channel) inside a raw EEG frame, as the SDK accepted it.
    /// </summary>
    public struct EegPackageMark
    {
        /// <summary>The SDK threw bytes away (a broken or unreadable package) just before this one,
        /// so at least one package is missing between it and the previous one.</summary>
        public bool LossBefore;
        /// <summary>UTC instant the SDK accepted this package (its last sample's arrival).</summary>
        public DateTime Utc;
    }

    /// <summary>Running totals of the SDK's package assembly (see SenzeBandService.SdkLog).</summary>
    public struct SdkPackageStats
    {
        /// <summary>Packages the SDK accepted and turned into EEG.</summary>
        public long Accepted;
        /// <summary>Times it threw bytes away (several can belong to one loss).</summary>
        public long DiscardEvents;
        /// <summary>Accepted packages that followed a discard, i.e. loss events.</summary>
        public long AcceptedAfterLoss;
    }

    /// <summary>One frame of raw EEG. The SDK delivers four channels (Fp1, Fp2, T4, T3).</summary>
    public class RawEegFrame
    {
        /// <summary>Raw integer samples as delivered by the SDK (assignRawDataDelegate).</summary>
        public int[] IntSamples { get; set; }
        /// <summary>Raw float samples in microvolts (assignRawDataFloatDelegate).</summary>
        public float[] FloatSamples { get; set; }
        /// <summary>
        /// UTC instant this frame's last sample arrived, captured SYNCHRONOUSLY on the SDK
        /// callback thread — not when a thread-pool handler later runs it. The per-sample
        /// timeline is anchored to this so it reflects true delivery timing rather than
        /// dispatch jitter (which previously stretched a 38 s stream across 53 s).
        ///
        /// The SDK hands over each raw frame one callback LATE (see OnRawInt), so this is the
        /// time of the previous callback, not of the one that delivered the frame.
        /// </summary>
        public DateTime ArrivalUtc { get; set; }
        /// <summary>The frame's packages in order (normally 5 x 50 samples), or null when the
        /// bridge could not follow the SDK's package bookkeeping for this frame.</summary>
        public EegPackageMark[] Packages { get; set; }
    }

    /// <summary>
    /// Drives the Neeuro SenzeBand SDK lifecycle and surfaces raw EEG.
    /// Lifecycle: Initialize -> OnInitialized -> StartScan -> OnDeviceFound
    ///            -> Connect -> OnConnected -> StartStream -> OnRawEeg* -> Shutdown.
    /// </summary>
    public class SenzeBandService
    {
        private static SenzeBandService _instance;
        public static SenzeBandService Instance => _instance ?? (_instance = new SenzeBandService());
        private SenzeBandService() { }

        private SynchronizationContext _context;

        // ── EEG data thread ─────────────────────────────────────────────────
        // Every SDK callback used to be Posted to the context captured at Initialize — in the WPF app,
        // the UI thread. So the 100 Hz low-pass, FFT, artefact detection and DB queueing all shared a
        // thread with chart rendering, the log box and modal dialogs, and any UI hiccup delayed the
        // EEG pipeline behind it. High-rate data callbacks now go to one dedicated thread instead: it
        // keeps their order (one consumer, FIFO — the filters are stateful and need it) and is never
        // blocked by the UI. Connection, scan, auth and status callbacks stay on the original context,
        // which is what the UI-facing handlers expect. Controller events raised from this thread are
        // marshalled to the UI by MainWindow.Ui() as before.
        private readonly BlockingCollection<Action> _dataQueue = new BlockingCollection<Action>();
        private Thread _dataThread;
        private const int DataBacklogWarn = 50;   // ~50 s of frames waiting = processing can't keep up
        private long _lastBacklogWarnTicks;
        private string _connectedAddress = "";
        private string _connectedDeviceID = "";
        private string _license = "";
        private string _mcuId;
        private bool _authAttempted;
        private bool _initialized;
        private volatile bool _isAuthenticated;

        // ── Connect auto-retry ──────────────────────────────────────────────
        // The Neeuro Windows SDK's first connectBT after a scan routinely times out
        // (~2 s) on a cold BLE radio; the next attempt succeeds because the stack is
        // now warm. We retry transparently so the technician only clicks Connect once
        // and only surface a real failure (OnDisconnected) once retries are exhausted.
        private volatile bool _connecting;
        private int _connectAttempts;
        private string _connectTargetId;
        private Timer _retryTimer;
        private const int MaxConnectAttempts = 3;
        private const int RetryDelayMs = 700;

        // ── Mid-session auto-reconnect (TS1.7) ──────────────────────────────
        // A drop AFTER a successful connect (band slips off the head, BLE link lost) is distinct
        // from a cold-connect failure. We transparently re-issue connectBT to the SAME device for
        // up to ReconnectBudgetMs before declaring the link truly gone — so an in-progress recording
        // resumes into the same session instead of being torn down. The technician's own Disconnect/
        // Shutdown sets _intentionalDisconnect so it is never treated as a recoverable drop.
        private volatile bool _intentionalDisconnect;
        private volatile bool _reconnecting;
        private string _reconnectDeviceId;
        private string _reconnectAddress;
        private Timer _reconnectTimer;
        private readonly Stopwatch _reconnectClock = new Stopwatch();
        private const int ReconnectBudgetMs = 60_000;   // give up after ~60 s of a missing band
        private const int ReconnectDelayMs = 1500;      // backoff between reconnect attempts
        private const int ReconnectLogEveryMs = 30_000; // past the budget, log progress this often (not every attempt)
        private long _lastReconnectLogMs;

        /// <summary>
        /// While true, a dropped link is retried for as long as it takes instead of giving up after
        /// <see cref="ReconnectBudgetMs"/>. The controller sets it while a recording is in progress: a
        /// band that is switched off or out of range for a minute should not end the session behind the
        /// technician's back — the gap is recorded honestly, and the technician (or the website ending
        /// the session) decides when it is over. Read on every attempt, so clearing it mid-outage lets
        /// the ordinary budget apply from then on.
        /// </summary>
        public volatile bool KeepReconnecting;

        // ── Authentication retry ────────────────────────────────────────────
        // Raw EEG stays locked until Neeuro's servers approve the device, and that round trip happens
        // on every (re)connect. A failed or timed-out attempt used to wait for the next MCU report or a
        // manual Re-auth — after a mid-session reconnect that meant the rest of the recording was lost.
        private static readonly int[] AuthRetryDelaysMs = { 2000, 5000, 10000, 20000, 30000 };   // last repeats
        private int _authFailures;
        private Timer _authRetryTimer;

        public bool IsConnected => !string.IsNullOrEmpty(_connectedAddress);
        public bool IsInitialized => _initialized;
        public bool IsAuthenticated => _isAuthenticated;
        /// <summary>True while a dropped link is being recovered.</summary>
        public bool IsReconnecting => _reconnecting;
        /// <summary>How long the current link recovery has been running (zero when not reconnecting).</summary>
        public TimeSpan ReconnectElapsed => _reconnecting ? _reconnectClock.Elapsed : TimeSpan.Zero;

        // ── Events ──────────────────────────────────────────────────────────
        public event Action OnInitialized;
        public event Action<SenzeBandDeviceInfo, bool> OnDeviceFound;   // info, added(true)/removed(false)
        public event Action<SenzeBandDeviceInfo> OnDeviceUpdated;
        public event Action<string, string> OnConnected;               // address, deviceID
        public event Action<string> OnConnectionInterrupted;           // address; transient link loss, reconnecting (session preserved)
        public event Action<string, string> OnReconnected;             // address, deviceID; link restored, same session resumes
        public event Action<string> OnDisconnected;                    // address; terminal (intentional or reconnect gave up)
        public event Action<bool> OnSignalReady;
        public event Action<bool[]> OnChannelStatus;
        public event Action<float[]> OnImpedance;                      // per-electrode impedance (Fp1, Fp2, T4, T3)
        public event Action<string> OnBattery;
        public event Action<int[]> OnSpo2HeartRate;                    // PPG-derived [SpO2, heartRate] (order/validity UNVERIFIED)
        public event Action<RawEegFrame> OnRawEeg;                     // raw ADC EEG (DC offset present)
        public event Action<float[]> OnFilteredEeg;                    // band-passed, zero-centered EEG
        public event Action<bool, string> OnAuthStatus;               // STANDARD-tier server auth (ok, detail)
        public event Action<string> OnLog;

        // ── SDK-computed cognitive features ─────────────────────────────────
        public event Action<float> OnAttention;
        public event Action<float> OnRelaxation;
        public event Action<float> OnMentalWorkload;
        // [channelIdx, bandIdx]: bandIdx 0=Alpha 1=Beta 2=Delta 3=Theta (SDK "ABDT" ordering).
        // Actual ordering unverifiable without live hardware; treat as a best-effort label until confirmed.
        public event Action<float[,]> OnAbdt;

        // ── Step 1: Initialize ──────────────────────────────────────────────
        public void Initialize(string licenseCode)
        {
            _license = licenseCode ?? "";
            _context = SynchronizationContext.Current ?? new SynchronizationContext();
            StartDataThread();
            Log("Initialize()");
            SenzeBandWindowsInterface.getSBWIHandler().initializeSBWI(
                ConnectedCallback,
                ConnectFailCallback,
                licenseCode ?? "",
                CompletedInitialization,
                SdkLog);   // SDK's own log is a per-packet firehose — keep it off the console
        }

        // ── Step 2: Scan ────────────────────────────────────────────────────
        public bool StartScan()
        {
            if (!_initialized) { Log("StartScan before init."); return false; }
            if (!SenzeBandWindowsInterface.IsBluetoothEnabled()) { Log("Bluetooth is OFF."); return false; }
            Log("Scanning for devices...");
            return SenzeBandWindowsInterface.getSBWIHandler()
                .startScanning(ReceiveScanResult, UpdateScanResult, EnumerationComplete);
        }

        public void StopScan()
        {
            SenzeBandWindowsInterface.getSBWIHandler().stopScanning();
            Log("Scan stopped.");
        }

        // ── Step 3: Connect ─────────────────────────────────────────────────
        public void Connect(string deviceID)
        {
            CancelReconnect();              // a deliberate new connect supersedes any drop recovery
            _intentionalDisconnect = false; // arm auto-reconnect for the connection we're about to open
            _connectTargetId = deviceID;
            _connectAttempts = 0;
            _connecting = true;
            AttemptConnect();
        }

        private void AttemptConnect()
        {
            _connectAttempts++;
            if (_connectAttempts == 1) Log("Connecting to " + _connectTargetId + " ...");
            else Log("Retrying connect to " + _connectTargetId + " (attempt " + _connectAttempts + "/" + MaxConnectAttempts + ")...");
            TimedConnectBT(_connectTargetId, "connect");
        }

        public void Disconnect()
        {
            _intentionalDisconnect = true;  // a drop callback from this teardown must NOT auto-reconnect
            CancelConnectRetry();
            CancelReconnect();
            // Clear per-connection auth state so a later reconnect authenticates from scratch. Left
            // stale, a reconnect would keep the old MCU id and a half-finished attempt, and raw EEG
            // could stay locked until the whole process was restarted (the reconnect-then-no-data bug).
            ResetAuthState();
            if (string.IsNullOrEmpty(_connectedAddress)) return;
            try { SenzeBandWindowsInterface.getSBWIHandler().disconnectBT(_connectedAddress); }
            catch (Exception ex) { Log("disconnectBT error: " + ex.Message); }
            _connectedAddress = "";
            _connectedDeviceID = "";
        }

        /// <summary>Drops all per-connection authentication state. A fresh connection must
        /// re-identify (MCU) and re-authenticate from zero; carrying any of this across a
        /// disconnect is what left raw EEG locked after a reconnect.</summary>
        private void ResetAuthState()
        {
            _mcuId = null;
            _authAttempted = false;
            _isAuthenticated = false;
            CancelAuthRetry();
            try { DeviceAuthentication.instance.OnDisconnect(); } catch { /* ignore */ }
        }

        private void CancelAuthRetry()
        {
            _authFailures = 0;
            var t = _authRetryTimer; _authRetryTimer = null;
            try { t?.Dispose(); } catch { }
        }

        // Called after a failed or timed-out authentication: try again with backoff for as long as
        // the band stays connected. A success, disconnect or new connection cancels it.
        private void ScheduleAuthRetry()
        {
            if (!IsConnected) return;
            int delay = AuthRetryDelaysMs[Math.Min(_authFailures, AuthRetryDelaysMs.Length - 1)];
            _authFailures++;
            Log($"Authentication will be retried in {delay / 1000} s (attempt {_authFailures + 1}) — raw EEG stays locked until it succeeds.");
            var t = new Timer(_ => Post(() =>
            {
                if (IsConnected && !_isAuthenticated) Authenticate();
            }), null, delay, Timeout.Infinite);
            var old = _authRetryTimer; _authRetryTimer = t;
            try { old?.Dispose(); } catch { }
        }

        private void CancelConnectRetry()
        {
            _connecting = false;
            var t = _retryTimer; _retryTimer = null;
            try { t?.Dispose(); } catch { }
        }

        private void CancelReconnect()
        {
            _reconnecting = false;
            var t = _reconnectTimer; _reconnectTimer = null;
            try { t?.Dispose(); } catch { }
            _reconnectClock.Reset();
        }

        // connectBT runs on the context captured at Initialize (the UI thread in WPF). Whether it
        // returns at once and reports back through the callbacks, or blocks until the radio answers,
        // is undocumented. Reconnect attempts land ~10 s apart in real logs, which would mean a frozen
        // UI during each attempt if it blocks. Since EEG processing now has its own thread, a block
        // only freezes the UI — but measure it, so the next step is decided on evidence.
        private void TimedConnectBT(string deviceId, string what)
        {
            var sw = Stopwatch.StartNew();
            try { SenzeBandWindowsInterface.getSBWIHandler().connectBT(deviceId); }
            catch (Exception ex) { Log(what + " connectBT error: " + ex.Message); }
            sw.Stop();
            if (sw.ElapsedMilliseconds >= 500)
                Log($"[diag] {what} connectBT blocked its calling thread for {sw.ElapsedMilliseconds} ms.");
        }

        // ── Mid-session reconnect loop ──────────────────────────────────────
        private void BeginReconnect(string droppedAddress)
        {
            _reconnecting = true;
            _reconnectDeviceId = _connectedDeviceID;
            _reconnectAddress = droppedAddress;
            _connectedAddress = "";          // link is down — block stream commands until restored
            _isAuthenticated = false;
            CancelAuthRetry();
            _reconnectClock.Restart();
            _lastReconnectLogMs = 0;
            Log("Link dropped — reconnecting to " + _reconnectDeviceId + " (up to " + (ReconnectBudgetMs / 1000) + " s)...");
            Post(() => OnConnectionInterrupted?.Invoke(droppedAddress));
            ScheduleReconnectAttempt();
        }

        private void ScheduleReconnectAttempt()
        {
            var t = new Timer(_ => Post(ReconnectAttempt), null, ReconnectDelayMs, Timeout.Infinite);
            var old = _reconnectTimer; _reconnectTimer = t;
            try { old?.Dispose(); } catch { }
        }

        private void ReconnectAttempt()
        {
            if (!_reconnecting) return;
            long elapsedMs = _reconnectClock.ElapsedMilliseconds;
            if (elapsedMs > ReconnectBudgetMs)
            {
                if (!KeepReconnecting)
                {
                    Log("Reconnect budget exhausted — link is gone.");
                    FinishReconnectFailed();
                    return;
                }
                // Recording in progress: keep trying, but don't flood the log with every attempt.
                if (elapsedMs - _lastReconnectLogMs >= ReconnectLogEveryMs)
                {
                    _lastReconnectLogMs = elapsedMs;
                    Log($"Band still unreachable after {elapsedMs / 1000} s — still reconnecting because a recording " +
                        "is in progress. Check the band is switched on, charged and nearby.");
                }
            }
            else
            {
                Log("Reconnect attempt to " + _reconnectDeviceId + " ...");
            }
            TimedConnectBT(_reconnectDeviceId, "reconnect");
            // A failed attempt re-enters ConnectFailCallback, which queues the next try (until budget).
        }

        private void FinishReconnectFailed()
        {
            string addr = _reconnectAddress;
            CancelReconnect();
            _connectedAddress = "";
            _connectedDeviceID = "";
            _mcuId = null;
            _isAuthenticated = false;
            _authAttempted = false;
            CancelAuthRetry();
            try { DeviceAuthentication.instance.OnDisconnect(); } catch { }
            Log("Disconnected (reconnect failed): " + addr);
            Post(() => OnDisconnected?.Invoke(addr));
        }

        // ── Step 4: Stream ──────────────────────────────────────────────────
        public void StartStream()
        {
            if (!IsConnected) { Log("StartStream but nothing connected."); return; }
            // Enables the SDK's analysis pipeline. Raw data flows regardless, but this
            // keeps signal-quality/channel reporting behaving as in the reference app.
            SenzeBandConnectInterface.getSBCIHandler().setEEG_Analyzing(true);
            SenzeBandWindowsInterface.getSBWIHandler().sendStartCommand(_connectedAddress);
            Log("Stream started.");
        }

        /// <summary>
        /// Re-sends the start command for a link that is up but has stopped delivering EEG (see the
        /// controller's stall watchdog). Safe from any thread: the SDK call is marshalled like every
        /// other callback-side action.
        /// </summary>
        public void RestartStream()
        {
            Post(() =>
            {
                if (!IsConnected) return;
                Log("Re-sending the stream start command (no EEG arriving)...");
                try { StartStream(); }
                catch (Exception ex) { Log("Stream restart error: " + ex.Message); }
            });
        }

        /// <summary>
        /// Switches the band's lead-off detection between AC (true: injects the small test current
        /// that <see cref="ImpedanceCheck"/> measures — it shows up in the EEG, so never while
        /// recording) and DC (false: the normal mode). SDK commands FD 01 01 / FD 01 00.
        /// </summary>
        public void SetLeadOffMode(bool ac)
        {
            Post(() =>
            {
                if (!IsConnected) return;
                try
                {
                    var sbwi = SenzeBandWindowsInterface.getSBWIHandler();
                    if (ac) sbwi.sendACLeadoffCommand(_connectedAddress);
                    else sbwi.sendDCLeadoffCommand(_connectedAddress);
                    Log(ac ? "Impedance test current on (AC lead-off)." : "Impedance test current off (DC lead-off).");
                }
                catch (Exception ex) { Log("Lead-off mode change failed: " + ex.Message); }
            });
        }

        public void StopStream()
        {
            SenzeBandConnectInterface.getSBCIHandler().setEEG_Analyzing(false);
            SenzeBandWindowsInterface.getSBWIHandler().sendStopCommand(_connectedAddress);
            Log("Stream stopped.");
        }

        // ── Init completion: wire all delegates ─────────────────────────────
        private void CompletedInitialization()
        {
            var sbci = SenzeBandConnectInterface.getSBCIHandler();

            // Status / signal-quality delegates we actually use.
            sbci.assignSignalReadyDelegate(v => Post(() => OnSignalReady?.Invoke(v)));
            sbci.assignChannelDelegate(v => Post(() => OnChannelStatus?.Invoke(v)));
            sbci.assignBatteryDelegate(v => Post(() => OnBattery?.Invoke(v)));

            // Raw EEG — the point of this app.
            sbci.assignRawDataDelegate(OnRawInt);
            sbci.assignRawDataFloatDelegate(OnRawFloat);

            // Required no-op delegates: connectingToNewDevice() invokes these
            // unconditionally; leaving any unassigned throws NullReferenceException
            // inside the SDK during connect.
            sbci.assignAttentionDelegate(v => PostData(() => OnAttention?.Invoke(v)));
            sbci.assignRelaxationDelegate(v => PostData(() => OnRelaxation?.Invoke(v)));
            sbci.assignMentalWorkloadDelegate(v => PostData(() => OnMentalWorkload?.Invoke(v)));
            sbci.assignABDTDelegate(v => { var c = (float[,])v?.Clone(); PostData(() => OnAbdt?.Invoke(c)); });
            sbci.assignAccDelegate(_ => { });
            sbci.assignMCUDelegate(OnMcu);   // MCU ID is needed to authenticate the device
            // Logged rather than dropped: device replies are evidence for the vendor when a link
            // misbehaves. The SDK routes every packet containing "41434BF7" here as chars 10-13 of the
            // whole packet (firmware 1.0.3.0 answers F7 with "1030"); command ACKs come as names.
            sbci.assignFirmwareVerDelegate(v => Log("Device F7 reply: " + v));
            sbci.assignConnectionCheckDelegate(_ => { });
            sbci.assignCommandACKDelegate(v => Log("Device command ACK: " + v));
            sbci.assignSenzebandVersionDelegate(_ => { });
            sbci.assignEvokeDelegate(_ => { });
            sbci.assignDirectionDelegate(_ => { });
            sbci.assignImpedanceDelegate(v => { var c = (float[])v?.Clone(); PostData(() => OnImpedance?.Invoke(c)); });
            sbci.assignCalParamsDelegate(_ => { });
            // SDK reuses its buffer; clone synchronously before the pooled handler (same race as raw).
            sbci.assignSPO2HeartRateDelegate(v => { var c = (int[])v?.Clone(); PostData(() => OnSpo2HeartRate?.Invoke(c)); });
            sbci.assignRawData200msDelegate(_ => { });
            sbci.assignFilteredDataDelegate(OnFiltered);   // band-passed, zero-centered EEG
            sbci.assignPPGDataDelegate(_ => { });     // must be assigned: PPG packets NPE grabCharacteristic otherwise
            sbci.assignDataInSpeedDelegate(_ => { });

            SetupAuthentication();

            _initialized = true;
            Log("SDK initialized.");
            Post(() => OnInitialized?.Invoke());
        }

        // ── STANDARD-tier server authentication ─────────────────────────────
        // The SDK only emits licensed data (raw EEG) after the connected device
        // is authenticated against Neeuro's servers. This needs internet + the
        // license key. Battery/channel/signal are NOT gated, which is why they
        // appear before authentication completes.
        private void SetupAuthentication()
        {
            try
            {
                if (!DeviceAuthentication.AuthenticationRequired())
                {
                    _isAuthenticated = true;
                    Log("Device authentication not required for this SDK tier.");
                    return;
                }

                Log("Device authentication required (STANDARD tier).");
                if (!DeviceAuthentication.instance.isThereInternet())
                    Log("WARNING: no internet connection detected — server authentication will fail.");

                DeviceAuthentication.instance.AssignAuthenticationStatusCallbacks(new AuthCallback(this));
                try { DeviceAuthentication.instance.SetDevcode(_license); } catch { }
                Log("Authentication callbacks assigned.");
            }
            catch (Exception ex)
            {
                Log("Authentication setup error: " + ex.Message);
            }
        }

        /// <summary>
        /// Triggers STANDARD-tier server authentication. Requires a connected device,
        /// its MCU ID, internet, and a valid license. The SDK calls Neeuro's servers
        /// and reports back via the AuthCallback. Raw EEG unlocks on a "200" result.
        /// Safe to call repeatedly; runs at most once per connection unless forced.
        /// </summary>
        public void Authenticate(bool force = false)
        {
            try
            {
                if (!DeviceAuthentication.AuthenticationRequired()) { _isAuthenticated = true; return; }
                if (_isAuthenticated && !force) return;
                if (!force && _authAttempted) return;
                if (!IsConnected) { Log("Authenticate: no device connected."); return; }
                if (string.IsNullOrEmpty(_mcuId)) { Log("Authenticate: waiting for device MCU ID..."); return; }

                _authAttempted = true;
                if (!DeviceAuthentication.instance.isThereInternet())
                    Log("WARNING: no internet — authentication will likely fail.");

                Log("Authenticating device with Neeuro servers (MCU " + _mcuId + ")...");
                try { DeviceAuthentication.instance.SetMCUID(_mcuId); } catch (Exception ex) { Log("SetMCUID error: " + ex.Message); }
                DeviceAuthentication.instance.getAuthentication();
            }
            catch (Exception ex)
            {
                Log("Authenticate error: " + ex.Message);
            }
        }

        private void OnMcu(string mcuId)
        {
            _mcuId = mcuId;
            Log("MCU ID: " + mcuId);
            // The device just (re)identified itself. If we are not yet authenticated, clear any
            // earlier in-flight/stale attempt so THIS MCU always drives a real auth pass — otherwise a
            // failed first attempt would leave _authAttempted set and block re-auth on a reconnect.
            if (!_isAuthenticated) _authAttempted = false;
            Authenticate();   // MCU ID is the last prerequisite; attempt auth now
        }

        private class AuthCallback : SenzeBandConnectInterface.deviceAuthenticationInterface
        {
            private readonly SenzeBandService _svc;
            public AuthCallback(SenzeBandService svc) { _svc = svc; }

            public void getAuthenticationResult(string address, string result, string message)
            {
                bool ok = result == "200";
                _svc._isAuthenticated = ok;
                // A failed result must not wedge: clear the attempt flag so the next MCU report or a
                // manual Re-auth can try again, rather than being blocked by "already attempted".
                if (!ok) _svc._authAttempted = false;
                _svc.Log($"Auth result for {address}: {result} {message}");
                _svc.Post(() =>
                {
                    if (ok) _svc.CancelAuthRetry(); else _svc.ScheduleAuthRetry();
                    _svc.OnAuthStatus?.Invoke(ok, result + " " + message);
                });
            }

            public void timeUp(object obj)
            {
                _svc._isAuthenticated = false;
                _svc._authAttempted = false;   // allow a retry instead of staying stuck unauthenticated
                _svc.Log("Authentication timed out.");
                _svc.Post(() =>
                {
                    _svc.ScheduleAuthRetry();
                    _svc.OnAuthStatus?.Invoke(false, "timeout");
                });
            }
        }

        // ── Raw / filtered EEG callbacks ────────────────────────────────────
        // The SDK reuses its sample buffer for the next frame, and PostData() runs the handler
        // LATER on the EEG data thread — so the buffer MUST be cloned and the arrival time
        // captured here, synchronously, before we hand off. Cloning in the handler (as it once
        // did) raced the SDK overwriting the buffer.
        //
        // ONE FRAME LATE: when the SDK completes a 1 s frame (5 packages) it fires the raw
        // callbacks BEFORE copying the new samples into the buffer it passes
        // (SenzeBandClass.analyzeEEGDataThread calls EEG_GetData, then fills EEGbuffer). So each
        // raw callback carries the frame completed at the PREVIOUS callback, and the first one after
        // the SDK starts carries an all-zero buffer. Measured on stored sessions that kept both
        // streams: raw trails the SDK's own filtered output by ~228 samples, i.e. one 250-sample
        // frame less the SDK filter's delay. Stamping at this callback put every stored sample ~1 s
        // after the moment it was recorded. The frame is therefore stamped with the previous
        // callback's time and given the previous frame's package marks; an all-zero buffer is
        // dropped (real ADC counts carry a large DC offset and are never all zero).
        private DateTime _prevRawCallbackUtc;
        private EegPackageMark[] _prevFramePackages;
        private DateTime _deliveredFrameEndUtc;      // reused by the float twin below
        private EegPackageMark[] _deliveredPackages;
        private bool _deliveredFrameValid;

        private void OnRawInt(int[] data)
        {
            DateTime now = DateTime.UtcNow;
            Interlocked.Exchange(ref _lastRawArrivalTicks, now.Ticks);

            EegPackageMark[] completedPackages = TakeFramePackages();
            DateTime frameEndUtc = _prevRawCallbackUtc;
            EegPackageMark[] packages = _prevFramePackages;
            _prevRawCallbackUtc = now;
            _prevFramePackages = completedPackages;

            _deliveredFrameValid = frameEndUtc != default(DateTime) && !IsAllZero(data);
            _deliveredFrameEndUtc = frameEndUtc;
            _deliveredPackages = packages;
            if (!_deliveredFrameValid) return;

            var frame = new RawEegFrame { IntSamples = (int[])data.Clone(), ArrivalUtc = frameEndUtc, Packages = packages };
            PostData(() => OnRawEeg?.Invoke(frame));
        }

        private static bool IsAllZero(int[] data)
        {
            if (data == null) return true;
            foreach (var v in data) if (v != 0) return false;
            return true;
        }

        // Stamped on the SDK's own callback thread, so the stall watchdog sees the band stop sending
        // even when the thread that processes frames is busy.
        private long _lastRawArrivalTicks;

        /// <summary>When the SDK last delivered a raw EEG frame (default if none yet).</summary>
        public DateTime LastRawArrivalUtc
        {
            get
            {
                long t = Interlocked.Read(ref _lastRawArrivalTicks);
                return t == 0 ? default(DateTime) : new DateTime(t, DateTimeKind.Utc);
            }
        }

        // Fired by the SDK straight after OnRawInt, for the same (one-late) frame.
        private void OnRawFloat(float[] data)
        {
            if (!_deliveredFrameValid) return;
            var frame = new RawEegFrame { FloatSamples = (float[])data.Clone(), ArrivalUtc = _deliveredFrameEndUtc, Packages = _deliveredPackages };
            PostData(() => OnRawEeg?.Invoke(frame));
        }

        private void OnFiltered(float[] data)
        {
            var copy = (float[])data.Clone();   // same buffer-reuse race as raw; clone before the handler runs
            PostData(() => OnFilteredEeg?.Invoke(copy));
        }

        // ── Scan callbacks ──────────────────────────────────────────────────
        private void ReceiveScanResult(ScannedDeviceClass device, bool addDevice)
            => Post(() => OnDeviceFound?.Invoke(ToInfo(device), addDevice));

        private void UpdateScanResult(ScannedDeviceClass device)
            => Post(() => OnDeviceUpdated?.Invoke(ToInfo(device)));

        private void EnumerationComplete() => Log("Enumeration complete.");

        // ── Connection callbacks ────────────────────────────────────────────
        private void ConnectedCallback(string address, string id, bool hasExistingConnection)
        {
            if (hasExistingConnection)
            {
                // The SDK already holds a link to this device — typically a prior disconnect that
                // hadn't fully torn down before we reconnected. We used to return here unconditionally
                // and WEDGE: no OnConnected/OnReconnected ever fired, so the app never re-prepared a
                // session and the only cure was restarting the exe. If a (re)connect is actually
                // pending, ADOPT the existing link and continue instead of dropping it on the floor.
                Log("Connect reported an existing connection to " + id + " @ " + address + ".");
                if (!_connecting && !_reconnecting)
                    return;   // unsolicited, nothing pending — ignore as before
            }
            bool wasReconnecting = _reconnecting;
            CancelConnectRetry();   // connect succeeded — stop the retry machinery
            CancelReconnect();      // ...and the drop-recovery loop, if this was a resume
            _connectedAddress = address;
            _connectedDeviceID = id;
            _isAuthenticated = false;
            _authAttempted = false;
            CancelAuthRetry();      // a fresh link starts its own auth (and retry) sequence
            if (wasReconnecting)
            {
                Log("Reconnected: " + id + " @ " + address);
                Post(() => OnReconnected?.Invoke(address, id));   // resume the SAME session, no fresh prepare
            }
            else
            {
                Log("Connected: " + id + " @ " + address);
                Post(() => OnConnected?.Invoke(address, id));
            }
            Authenticate();   // attempt now if MCU ID is already available (re-auth on resume too)
        }

        private void ConnectFailCallback(string address)
        {
            // 1) Cold-radio connect attempt that still has retries left: re-issue connectBT after a
            //    short settle delay and DON'T report failure yet.
            if (_connecting && _connectAttempts < MaxConnectAttempts)
            {
                Log("Connect attempt " + _connectAttempts + " failed; retrying in " + RetryDelayMs + " ms...");
                var t = new Timer(_ => Post(AttemptConnect), null, RetryDelayMs, Timeout.Infinite);
                var old = _retryTimer; _retryTimer = t;
                try { old?.Dispose(); } catch { }
                return;
            }

            // 2) Already recovering a drop: a reconnect attempt failed — queue the next one
            //    (ReconnectAttempt enforces the overall time budget and gives up if exceeded).
            if (_reconnecting)
            {
                ScheduleReconnectAttempt();
                return;
            }

            // 3) A live link dropped unexpectedly — not a cold connect, not technician-initiated.
            //    Transparently reconnect to the same device so an in-progress session survives.
            if (!_connecting && !_intentionalDisconnect && !string.IsNullOrEmpty(_connectedDeviceID)
                && !string.IsNullOrEmpty(_connectedAddress))
            {
                BeginReconnect(address);
                return;
            }

            // 4) Terminal: cold-connect exhausted, technician-initiated, or nothing to recover.
            _connecting = false;
            _connectedAddress = "";
            _connectedDeviceID = "";
            _mcuId = null;
            _isAuthenticated = false;
            _authAttempted = false;
            CancelAuthRetry();
            try { DeviceAuthentication.instance.OnDisconnect(); } catch { }
            Log("Disconnected/failed: " + address);
            Post(() => OnDisconnected?.Invoke(address));
        }

        // ── Helpers ─────────────────────────────────────────────────────────
        private static SenzeBandDeviceInfo ToInfo(ScannedDeviceClass d) => new SenzeBandDeviceInfo
        {
            DeviceID = d.deviceID,
            DeviceName = d.deviceName,
            DeviceAddress = d.deviceAddress,
            IsConnected = d.isConnected,
            CanPair = d.canPair,
            IsEnabled = d.isEnabled
        };

        private void StartDataThread()
        {
            if (_dataThread != null) return;
            _dataThread = new Thread(RunDataThread)
            {
                IsBackground = true,                      // never keeps the process alive on exit
                Name = "SenzeBand EEG data",
                Priority = ThreadPriority.AboveNormal,    // EEG must not wait behind UI or housekeeping work
            };
            _dataThread.Start();
        }

        private void RunDataThread()
        {
            foreach (var action in _dataQueue.GetConsumingEnumerable())
            {
                try { action(); }
                catch (Exception ex)
                {
                    // One bad frame must not stop every later frame from being processed.
                    Log("EEG data handler error (frame skipped): " + ex.GetType().Name + ": " + ex.Message);
                }
            }
        }

        private void PostData(Action action)
        {
            if (_dataThread == null || _dataQueue.IsAddingCompleted) { Post(action); return; }
            try { _dataQueue.Add(action); }
            catch (InvalidOperationException) { return; }   // shutting down
            int depth = _dataQueue.Count;
            if (depth > DataBacklogWarn)
            {
                long now = DateTime.UtcNow.Ticks;
                if (now - Interlocked.Read(ref _lastBacklogWarnTicks) > TimeSpan.TicksPerSecond * 30)
                {
                    Interlocked.Exchange(ref _lastBacklogWarnTicks, now);
                    Log($"WARNING: {depth} EEG callbacks waiting to be processed — this PC is not keeping up.");
                }
            }
        }

        private void Post(Action action)
        {
            if (_context != null) _context.Post(_ => action(), null);
            else action();
        }

        private void Log(string message)
        {
            Debug.WriteLine("[SenzeBand] " + message);
            Post(() => OnLog?.Invoke(message));
        }

        // The SDK's internal errorLog fires per BLE packet (header parsing, buffer
        // counts, accelerometer, etc.). Route it to the debugger only so it never
        // floods the interactive console.
        //
        // It is also the only view of how the SDK assembles 645-byte packages from BLE
        // notifications, so a few of its messages are counted (see the package bookkeeping
        // below). It runs synchronously on the thread that then fires the raw callbacks.
        private void SdkLog(string message)
        {
            Debug.WriteLine("[sdk] " + message);
            if (message == null) return;
            if (message.StartsWith("Correct header in do_analyze", StringComparison.Ordinal))
                OnSdkPackageAccepted();
            else if (message.StartsWith("intBufferCount exceeded", StringComparison.Ordinal)
                  || message.StartsWith("Cannot find Header!", StringComparison.Ordinal)
                  || message.StartsWith("doAnalyze sbInstance.correctHeader: False", StringComparison.Ordinal))
                OnSdkBytesDiscarded();
        }

        // ── SDK package bookkeeping ─────────────────────────────────────────
        // The SDK only accepts a package when exactly 645 bytes, starting with a valid header,
        // arrive in order. If a BLE notification is missing, the partial package is thrown away
        // ("intBufferCount exceeded"), and so is everything until a notification happens to start
        // on the next header ("Cannot find Header!"). Each such message therefore means at least
        // one package is gone. Recording it against the next accepted package lets the uploader put
        // the gap exactly there, instead of finding it later from drifting arrival times.
        private readonly object _pkgLock = new object();
        private readonly List<EegPackageMark> _framePackages = new List<EegPackageMark>(PackagesPerFrame);
        private bool _discardSincePackage;
        private long _sdkPackagesAccepted;
        private long _sdkDiscardEvents;
        private long _sdkPackagesAfterLoss;

        private const int PackagesPerFrame = 5;

        private void OnSdkPackageAccepted()
        {
            lock (_pkgLock)
            {
                _framePackages.Add(new EegPackageMark { LossBefore = _discardSincePackage, Utc = DateTime.UtcNow });
                if (_discardSincePackage) _sdkPackagesAfterLoss++;
                _discardSincePackage = false;
                _sdkPackagesAccepted++;
            }
        }

        private void OnSdkBytesDiscarded()
        {
            lock (_pkgLock)
            {
                _discardSincePackage = true;
                _sdkDiscardEvents++;
            }
        }

        // The packages accepted since the last raw callback: the frame the SDK just completed. A
        // frame is 5 packages; any other count means the bookkeeping is out of step (e.g. the
        // stream restarted mid-frame), and the marks are withheld rather than misplaced.
        private EegPackageMark[] TakeFramePackages()
        {
            lock (_pkgLock)
            {
                var marks = _framePackages.Count == PackagesPerFrame ? _framePackages.ToArray() : null;
                _framePackages.Clear();
                return marks;
            }
        }

        /// <summary>Running totals from the SDK's package assembly, for diagnostics.</summary>
        public SdkPackageStats GetSdkPackageStats()
        {
            lock (_pkgLock)
                return new SdkPackageStats
                {
                    Accepted = _sdkPackagesAccepted,
                    DiscardEvents = _sdkDiscardEvents,
                    AcceptedAfterLoss = _sdkPackagesAfterLoss,
                };
        }

        public void Shutdown()
        {
            Log("Shutdown()");
            _intentionalDisconnect = true;
            CancelConnectRetry();
            CancelReconnect();
            CancelAuthRetry();
            try
            {
                if (!string.IsNullOrEmpty(_connectedAddress))
                {
                    SenzeBandConnectInterface.getSBCIHandler().setEEG_Analyzing(false);
                    SenzeBandWindowsInterface.getSBWIHandler().sendStopCommand(_connectedAddress);
                    SenzeBandWindowsInterface.getSBWIHandler().disconnectBT(_connectedAddress);
                    _connectedAddress = "";
                    _connectedDeviceID = "";
                }
            }
            catch (Exception ex) { Log("Shutdown disconnect error: " + ex.Message); }

            try { SenzeBandWindowsInterface.getSBWIHandler().stopScanning(); }
            catch (Exception ex) { Log("Shutdown stopScanning error: " + ex.Message); }

            _initialized = false;
            try { _dataQueue.CompleteAdding(); } catch { /* ignore */ }
        }
    }
}
