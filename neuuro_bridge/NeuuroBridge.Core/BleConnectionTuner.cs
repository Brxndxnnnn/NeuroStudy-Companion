using System;
using System.Globalization;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;

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
                var request = device.RequestPreferredConnectionParameters(
                    BluetoothLEPreferredConnectionParameters.ThroughputOptimized);

                lock (_gate)
                {
                    _device = device;
                    _request = request;
                }
                _log("[ble] requested ThroughputOptimized connection parameters — " +
                     "held for the lifetime of this connection.");
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
            lock (_gate)
            {
                request = _request; device = _device;
                _request = null; _device = null;
            }
            if (request != null) { try { request.Dispose(); } catch { /* ignore */ } }
            if (device != null) { try { device.Dispose(); } catch { /* ignore */ } }
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

            var cleaned = text.Trim().Replace(":", "").Replace("-", "").Replace(" ", "");
            if (cleaned.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                cleaned = cleaned.Substring(2);
            if (cleaned.Length == 0) return false;

            // A 12-character all-hex string is a MAC. Anything all-decimal is the numeric form.
            // Order matters: "227405302602318" is valid hex too, so decimal is tried FIRST for
            // anything that is not exactly a 12-digit MAC, or a plain decimal id would be read as
            // hex and silently address a different device.
            bool looksLikeMac = cleaned.Length == 12 && IsHex(cleaned);
            if (!looksLikeMac && ulong.TryParse(cleaned, NumberStyles.None, CultureInfo.InvariantCulture, out address))
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
    }
}
