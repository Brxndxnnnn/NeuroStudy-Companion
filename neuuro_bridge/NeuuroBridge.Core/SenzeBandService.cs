using System;
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

    /// <summary>One frame of raw EEG. The SDK delivers four channels (Fp1, Fp2, T4, T3).</summary>
    public class RawEegFrame
    {
        /// <summary>Raw integer samples as delivered by the SDK (assignRawDataDelegate).</summary>
        public int[] IntSamples { get; set; }
        /// <summary>Raw float samples in microvolts (assignRawDataFloatDelegate).</summary>
        public float[] FloatSamples { get; set; }
        /// <summary>
        /// UTC instant the SDK delivered this frame, captured SYNCHRONOUSLY on the SDK
        /// callback thread — not when a thread-pool handler later runs it. The per-sample
        /// timeline is anchored to this so it reflects true delivery timing rather than
        /// dispatch jitter (which previously stretched a 38 s stream across 53 s).
        /// </summary>
        public DateTime ArrivalUtc { get; set; }
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

        public bool IsConnected => !string.IsNullOrEmpty(_connectedAddress);
        public bool IsInitialized => _initialized;
        public bool IsAuthenticated => _isAuthenticated;

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
            try { SenzeBandWindowsInterface.getSBWIHandler().connectBT(_connectTargetId); }
            catch (Exception ex) { Log("connectBT error: " + ex.Message); }
        }

        public void Disconnect()
        {
            _intentionalDisconnect = true;  // a drop callback from this teardown must NOT auto-reconnect
            CancelConnectRetry();
            CancelReconnect();
            if (string.IsNullOrEmpty(_connectedAddress)) return;
            SenzeBandWindowsInterface.getSBWIHandler().disconnectBT(_connectedAddress);
            _connectedAddress = "";
            _connectedDeviceID = "";
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

        // ── Mid-session reconnect loop ──────────────────────────────────────
        private void BeginReconnect(string droppedAddress)
        {
            _reconnecting = true;
            _reconnectDeviceId = _connectedDeviceID;
            _reconnectAddress = droppedAddress;
            _connectedAddress = "";          // link is down — block stream commands until restored
            _isAuthenticated = false;
            _reconnectClock.Restart();
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
            if (_reconnectClock.ElapsedMilliseconds > ReconnectBudgetMs)
            {
                Log("Reconnect budget exhausted — link is gone.");
                FinishReconnectFailed();
                return;
            }
            Log("Reconnect attempt to " + _reconnectDeviceId + " ...");
            try { SenzeBandWindowsInterface.getSBWIHandler().connectBT(_reconnectDeviceId); }
            catch (Exception ex) { Log("reconnect connectBT error: " + ex.Message); }
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
            sbci.assignAttentionDelegate(v => Post(() => OnAttention?.Invoke(v)));
            sbci.assignRelaxationDelegate(v => Post(() => OnRelaxation?.Invoke(v)));
            sbci.assignMentalWorkloadDelegate(v => Post(() => OnMentalWorkload?.Invoke(v)));
            sbci.assignABDTDelegate(v => Post(() => OnAbdt?.Invoke(v)));
            sbci.assignAccDelegate(_ => { });
            sbci.assignMCUDelegate(OnMcu);   // MCU ID is needed to authenticate the device
            sbci.assignFirmwareVerDelegate(_ => { });
            sbci.assignConnectionCheckDelegate(_ => { });
            sbci.assignCommandACKDelegate(_ => { });
            sbci.assignSenzebandVersionDelegate(_ => { });
            sbci.assignEvokeDelegate(_ => { });
            sbci.assignDirectionDelegate(_ => { });
            sbci.assignImpedanceDelegate(v => Post(() => OnImpedance?.Invoke(v)));
            sbci.assignCalParamsDelegate(_ => { });
            // SDK reuses its buffer; clone synchronously before the pooled handler (same race as raw).
            sbci.assignSPO2HeartRateDelegate(v => { var c = (int[])v.Clone(); Post(() => OnSpo2HeartRate?.Invoke(c)); });
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
                _svc.Log($"Auth result for {address}: {result} {message}");
                _svc.Post(() => _svc.OnAuthStatus?.Invoke(ok, result + " " + message));
            }

            public void timeUp(object obj)
            {
                _svc._isAuthenticated = false;
                _svc.Log("Authentication timed out.");
                _svc.Post(() => _svc.OnAuthStatus?.Invoke(false, "timeout"));
            }
        }

        // ── Raw / filtered EEG callbacks ────────────────────────────────────
        // The SDK reuses its sample buffer for the next frame, and Post() runs the handler
        // LATER on a thread-pool thread — so the buffer MUST be cloned and the arrival time
        // captured here, synchronously, before we hand off. Cloning on the pooled handler
        // (as before) raced the SDK overwriting the buffer.
        private void OnRawInt(int[] data)
        {
            var frame = new RawEegFrame { IntSamples = (int[])data.Clone(), ArrivalUtc = DateTime.UtcNow };
            Post(() => OnRawEeg?.Invoke(frame));
        }

        private void OnRawFloat(float[] data)
        {
            var frame = new RawEegFrame { FloatSamples = (float[])data.Clone(), ArrivalUtc = DateTime.UtcNow };
            Post(() => OnRawEeg?.Invoke(frame));
        }

        private void OnFiltered(float[] data)
        {
            var copy = (float[])data.Clone();   // same buffer-reuse race as raw; clone before the pooled handler
            Post(() => OnFilteredEeg?.Invoke(copy));
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
            if (hasExistingConnection) return;
            bool wasReconnecting = _reconnecting;
            CancelConnectRetry();   // connect succeeded — stop the retry machinery
            CancelReconnect();      // ...and the drop-recovery loop, if this was a resume
            _connectedAddress = address;
            _connectedDeviceID = id;
            _isAuthenticated = false;
            _authAttempted = false;
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
        private void SdkLog(string message) => Debug.WriteLine("[sdk] " + message);

        public void Shutdown()
        {
            Log("Shutdown()");
            _intentionalDisconnect = true;
            CancelConnectRetry();
            CancelReconnect();
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
        }
    }
}
