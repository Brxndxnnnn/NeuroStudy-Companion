using System;
using System.Globalization;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation.Metadata;

namespace NeuuroBridge
{
    /// <summary>
    /// Asks Windows for a faster BLE connection interval while a session is running.
    ///
    /// WHY THIS EXISTS
    /// ---------------
    /// The SenzeBand samples a true 250 Hz and packs it into 645-byte packages at 5/s — about
    /// 3,225 bytes/s, delivered as ~40 BLE notifications of 80 bytes. Measured throughput says
    /// only ~32 of those 40 arrive each second (~31 ms per notification, i.e. Windows' default
    /// ~30 ms connection interval with one notification per connection event). The link is
    /// roughly 20% short of the rate the device wants to transmit at, so its queue backs up and
    /// sheds notifications.
    ///
    /// The cost of each dropped notification is disproportionate: the vendor SDK discards the
    /// entire 645-byte package it belonged to (534 such short packages in one 18-minute session,
    /// each arriving at 565 bytes instead of 645) and then burns ~7 more notifications
    /// re-syncing to the next header. One lost 80-byte chunk therefore costs ~0.4 s of EEG —
    /// roughly 8x its own size. Across all 18 completed sessions the mean loss was 20%.
    ///
    /// Requesting ThroughputOptimized (7.5–15 ms) gives 66–133 notification slots per second
    /// against the ~40 needed, which is comfortable headroom.
    ///
    /// WHY IT OPENS ITS OWN HANDLE
    /// ---------------------------
    /// The vendor SDK owns the connection and exposes no way to reach its BluetoothLEDevice
    /// (its binary contains no ConnectionParameter/MTU identifiers at all — it simply accepts
    /// whatever Windows negotiates). Reflecting into a closed-source vendor DLL to steal the
    /// object would be fragile. It isn't necessary: connection parameters are a property of the
    /// physical LINK, and Windows aggregates requests across every client on the machine,
    /// applying the most aggressive one. A second handle to the same address is enough, and
    /// getting a handle to an already-connected device neither reconnects nor re-pairs it.
    ///
    /// STRICTLY BEST-EFFORT
    /// --------------------
    /// BLE parameter updates are a REQUEST: the peripheral may decline, and the SenzeBand's
    /// firmware behaviour here is unverified. Every failure path is swallowed and logged. This
    /// must never be able to affect a recording — a session that streams at the old rate is
    /// vastly better than one that doesn't start.
    /// </summary>
    public sealed class BleConnectionTuner : IDisposable
    {
        private readonly Action<string> _log;
        private readonly object _gate = new object();
        private BluetoothLEDevice _device;
        private BluetoothLEPreferredConnectionParametersRequest _request;
        private GattSession _session;

        public BleConnectionTuner(Action<string> log)
        {
            _log = log ?? (_ => { });
        }

        /// <summary>True once Windows has accepted a throughput request that is still held open.</summary>
        public bool IsActive { get { lock (_gate) return _request != null; } }

        /// <summary>
        /// Fire-and-forget: requests a faster interval for <paramref name="addressText"/> and holds
        /// the request until <see cref="Dispose"/>. Safe to call on a BLE/UI callback thread — the
        /// work runs off-thread, because opening the device handle is a real I/O round trip and
        /// blocking the SDK's connect callback is what starved the BLE handshake in PrepareSession.
        /// </summary>
        /// <param name="addressCandidates">The identifiers the SDK gave us for this device, best
        /// first. The connect callback's `address` and `deviceID` are two encodings of the same
        /// 48-bit value, but which encoding lands in which parameter is a vendor detail — so try
        /// each and use the first that parses rather than hard-coding an assumption.</param>
        public void RequestThroughputAsync(params string[] addressCandidates)
        {
            if (addressCandidates != null)
            {
                foreach (var candidate in addressCandidates)
                {
                    ulong address;
                    if (TryParseBluetoothAddress(candidate, out address))
                    {
                        Task.Run(() => RequestThroughput(address));
                        return;
                    }
                }
            }
            _log("[ble] cannot tune connection: no usable device address supplied.");
        }

        private async void RequestThroughput(ulong address)
        {
            try
            {
                Release();   // a reconnect re-requests against the new link

                var device = await BluetoothLEDevice.FromBluetoothAddressAsync(address);
                if (device == null)
                {
                    _log("[ble] connection tuning skipped: Windows returned no device for that address.");
                    return;
                }

                // ThroughputOptimized asks for the shortest interval Windows will negotiate.
                // The peripheral is free to refuse, in which case this silently changes nothing.
                LogLinkParameters(device, "before tuning");

                var request = device.RequestPreferredConnectionParameters(
                    BluetoothLEPreferredConnectionParameters.ThroughputOptimized);
                device.ConnectionStatusChanged += OnConnectionStatusChanged;
                if (HasConnectionParameterApi)
                    device.ConnectionParametersChanged += OnConnectionParametersChanged;

                lock (_gate)
                {
                    _device = device;
                    _request = request;
                }
                _log("[ble] requested ThroughputOptimized connection parameters — " +
                     "held for the lifetime of this connection.");

                await OpenGattSession(device);

                // The peripheral answers the request asynchronously; ConnectionParametersChanged logs
                // the outcome when it does, and this catches the case where nothing ever changes.
                await Task.Delay(3000);
                if (ReferenceEquals(CurrentDevice, device)) LogLinkParameters(device, "3 s after tuning");
            }
            catch (Exception ex)
            {
                // Unsupported OS build, a revoked handle, the device dropping mid-request — all
                // land here and all are non-fatal. Streaming continues at whatever rate the
                // default negotiation gave us, exactly as before this class existed.
                _log("[ble] connection tuning unavailable (" + ex.Message + ") — continuing at the default rate.");
            }
        }

        /// <summary>Drops the request, letting Windows fall back to its default parameters.</summary>
        public void Release()
        {
            BluetoothLEPreferredConnectionParametersRequest request;
            BluetoothLEDevice device;
            GattSession session;
            lock (_gate)
            {
                request = _request; device = _device; session = _session;
                _request = null; _device = null; _session = null;
            }
            if (request != null) { try { request.Dispose(); } catch { /* ignore */ } }
            if (session != null)
            {
                try { session.MaxPduSizeChanged -= OnMaxPduSizeChanged; } catch { /* ignore */ }
                // MaintainConnection must be dropped before the technician's own disconnect, or
                // Windows would keep holding the link the SDK is trying to close.
                try { session.MaintainConnection = false; } catch { /* ignore */ }
                try { session.Dispose(); } catch { /* ignore */ }
            }
            if (device != null)
            {
                try { device.ConnectionStatusChanged -= OnConnectionStatusChanged; } catch { /* ignore */ }
                if (HasConnectionParameterApi)
                {
                    try { device.ConnectionParametersChanged -= OnConnectionParametersChanged; } catch { /* ignore */ }
                }
                try { device.Dispose(); } catch { /* ignore */ }
            }
        }

        // ── Link diagnostics ─────────────────────────────────────────────────
        // The packet-loss investigation has been stuck on one unknown: Windows granting the request
        // says nothing about whether the SenzeBand accepted a shorter interval. Windows 11 exposes
        // what was actually negotiated, so log it on connect, whenever it changes, and alongside
        // Windows' own view of every connect/disconnect (which can differ in timing from the SDK's).

        // BluetoothLEDevice.GetConnectionParameters / ConnectionParametersChanged / GetConnectionPhy
        // arrived in Windows 11 (build 22000). On Windows 10 these are skipped, not fatal.
        private static readonly bool HasConnectionParameterApi = SafeIsMethodPresent(
            "Windows.Devices.Bluetooth.BluetoothLEDevice", "GetConnectionParameters");

        private static bool SafeIsMethodPresent(string type, string method)
        {
            try { return ApiInformation.IsMethodPresent(type, method); }
            catch { return false; }
        }

        private BluetoothLEDevice CurrentDevice { get { lock (_gate) return _device; } }

        private void LogLinkParameters(BluetoothLEDevice device, string when)
        {
            if (!HasConnectionParameterApi)
            {
                _log($"[ble] link parameters ({when}): not available before Windows 11.");
                return;
            }
            try
            {
                var p = device.GetConnectionParameters();
                string phy = DescribePhy(device);
                // Interval is in 1.25 ms units and link timeout in 10 ms units (Bluetooth Core spec).
                double intervalMs = p.ConnectionInterval * 1.25;
                _log($"[ble] link parameters ({when}): interval {intervalMs:F2} ms, peripheral latency " +
                     $"{p.ConnectionLatency}, supervision timeout {p.LinkTimeout * 10} ms{phy}. " +
                     (intervalMs <= 15.0
                         ? "Throughput-optimised interval is in effect."
                         : "Still a slow interval — the band (or Windows) has not applied the faster one."));
            }
            catch (Exception ex)
            {
                _log($"[ble] link parameters ({when}) unavailable: {ex.Message}");
            }
        }

        private static string DescribePhy(BluetoothLEDevice device)
        {
            try
            {
                var phy = device.GetConnectionPhy();
                var tx = phy.TransmitInfo;
                string name = tx.IsUncoded2MPhy ? "2M" : tx.IsUncoded1MPhy ? "1M" : tx.IsCodedPhy ? "Coded" : "unknown";
                return $", PHY {name}";
            }
            catch { return ""; }
        }

        private void OnConnectionParametersChanged(BluetoothLEDevice sender, object args)
            => LogLinkParameters(sender, "changed");

        private void OnConnectionStatusChanged(BluetoothLEDevice sender, object args)
        {
            try
            {
                _log($"[ble] Windows reports the link as {sender.ConnectionStatus} " +
                     $"at {DateTime.Now:HH:mm:ss.fff}.");
            }
            catch { /* diagnostics only */ }
        }

        // GattSession gives the negotiated packet size (MTU) and, optionally, MaintainConnection,
        // which asks Windows to hold the link open and restore it if it drops. How that interacts
        // with the vendor SDK's own connection handling is unknown, so it is OFF unless the env key
        // BLE_MAINTAIN_CONNECTION=true is set — an experiment to measure, not a default.
        private async Task OpenGattSession(BluetoothLEDevice device)
        {
            try
            {
                var session = await GattSession.FromDeviceIdAsync(device.BluetoothDeviceId);
                if (session == null) return;
                session.MaxPduSizeChanged += OnMaxPduSizeChanged;
                bool maintain = string.Equals(EnvConfig.FindDotEnvValue("BLE_MAINTAIN_CONNECTION")?.Trim(), "true",
                                              StringComparison.OrdinalIgnoreCase);
                if (maintain && session.CanMaintainConnection) session.MaintainConnection = true;
                lock (_gate)
                {
                    if (!ReferenceEquals(_device, device)) { session.Dispose(); return; }   // released meanwhile
                    _session = session;
                }
                _log($"[ble] GATT max PDU {session.MaxPduSize} bytes" +
                     (maintain ? (session.MaintainConnection ? "; MaintainConnection ON (experiment)." : "; MaintainConnection not supported.") : "."));
            }
            catch (Exception ex)
            {
                _log("[ble] GATT session diagnostics unavailable: " + ex.Message);
            }
        }

        private void OnMaxPduSizeChanged(GattSession sender, object args)
        {
            try { _log($"[ble] GATT max PDU changed to {sender.MaxPduSize} bytes."); }
            catch { /* diagnostics only */ }
        }

        public void Dispose() => Release();

        /// <summary>
        /// Parses the address the SDK hands us into the 48-bit form the Windows API wants.
        ///
        /// The SDK reports the SAME device two ways — a decimal string ("227405302602318") and a
        /// hex MAC ("CED2EC481A4E"), which are the same number — and which of the two arrives here
        /// depends on whether it came from the connect callback or a scan result. Accept both, plus
        /// the usual separator styles, rather than depending on that detail.
        /// </summary>
        internal static bool TryParseBluetoothAddress(string text, out ulong address)
        {
            address = 0;
            if (string.IsNullOrWhiteSpace(text)) return false;

            var trimmed = text.Trim();
            // Separators and a 0x prefix are positive evidence of hex, so capture them BEFORE they
            // are stripped — otherwise a separated all-numeric MAC ("00:11:22:33:44:55") would be
            // indistinguishable from a decimal id once cleaned.
            bool hadHexMarkup = trimmed.IndexOf(':') >= 0 || trimmed.IndexOf('-') >= 0
                             || trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase);

            var cleaned = trimmed.Replace(":", "").Replace("-", "").Replace(" ", "");
            if (cleaned.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                cleaned = cleaned.Substring(2);
            if (cleaned.Length == 0) return false;

            // Interpret as hex ONLY on positive evidence: separators, a 0x prefix, or an a–f
            // hex letter (which a decimal number can never contain). Everything else is the
            // decimal numeric form and is parsed as decimal — the previous length-based rule
            // treated any 12-digit string as a MAC, so a 12-digit DECIMAL id (BLE addresses whose
            // leading byte is 0x00–0x03) was read as hex and silently addressed a different
            // device. The only residual ambiguity is a bare, unseparated, all-numeric 12-char
            // string; that is parsed as decimal, matching the SDK's own decimal encoding, and the
            // caller anyway supplies the hex encoding as a second candidate.
            bool isHex = hadHexMarkup || ContainsHexLetter(cleaned);
            if (!isHex && ulong.TryParse(cleaned, NumberStyles.None, CultureInfo.InvariantCulture, out address))
                return address != 0;
            if (IsHex(cleaned) &&
                ulong.TryParse(cleaned, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out address))
                return address != 0;

            address = 0;
            return false;
        }

        private static bool IsHex(string s)
        {
            foreach (var c in s)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')))
                    return false;
            return true;
        }

        // An a–f/A–F hex letter that a decimal number can never contain — positive proof the
        // string is a hex MAC rather than the decimal numeric id.
        private static bool ContainsHexLetter(string s)
        {
            foreach (var c in s)
                if ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))
                    return true;
            return false;
        }
    }
}
