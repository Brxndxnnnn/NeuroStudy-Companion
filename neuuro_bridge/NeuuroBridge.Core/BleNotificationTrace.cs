using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace NeuuroBridge
{
    /// <summary>
    /// Opt-in Bluetooth trace (env key BLE_TRACE=true): listens to the SenzeBand's EEG notifications
    /// alongside the vendor SDK and reports, every 10 s, how much the band actually delivered against
    /// how much the SDK turned into EEG.
    ///
    /// WHY
    /// ---
    /// A gap in the stored EEG has two possible causes, and only one of them is ours to fix:
    ///  - the band's data never reached the PC (radio interference, or the band's send buffer
    ///    overflowing) — hardware or environment; or
    ///  - it arrived, but the SDK threw it away while assembling 645-byte packages from the
    ///    notifications — software.
    /// The SDK's own log only shows the second view. This class watches the same notifications
    /// independently, finds the band's package headers itself, and counts intact packages. Intact
    /// packages the SDK did not accept point at the SDK; packages that never arrived point at the
    /// radio or the band.
    ///
    /// SAFETY
    /// ------
    /// Read-only towards the band: it only adds its own ValueChanged handlers. Notifications are
    /// already switched on by the SDK; only if none reach these handlers within 3 s is the
    /// subscription (CCCD) written as Notify again, which is what it already is. It is never written
    /// back to None, which would stop the SDK's stream as well. Every failure is logged and
    /// swallowed: the trace must never be able to affect a recording.
    ///
    /// Each notification is also written to ble_trace_*.csv in the logs folder (arrival time,
    /// Windows' timestamp, characteristic, length, bytes) so a session can be re-analysed offline.
    /// </summary>
    public sealed class BleNotificationTrace : IDisposable
    {
        // The SDK subscribes to these: seven round-robin data characteristics, or one on BT5 bands.
        private static readonly Guid[] DataCharacteristics =
        {
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129601"),
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129602"),
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129603"),
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129604"),
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129605"),
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129606"),
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129607"),
            Guid.Parse("6e400003-b5a3-f393-e0a9-e50e24dcca9e"),
        };

        // A package: 45-byte header + 600 data bytes (50 samples x 4 channels x 3 bytes) = 0.2 s.
        // The header's bytes 1-7 are "NEEURO2".
        private const int PackageBytes = 645;
        private const double PackagesPerSecond = 5.0;
        private static readonly byte[] Signature = Encoding.ASCII.GetBytes("NEEURO2");

        private const int SummaryIntervalMs = 10000;

        public static bool Enabled =>
            string.Equals(EnvConfig.FindDotEnvValue("BLE_TRACE")?.Trim(), "true", StringComparison.OrdinalIgnoreCase);

        private readonly Action<string> _log;
        private readonly Func<SdkPackageStats> _sdkStats;
        private readonly object _gate = new object();
        private readonly List<GattCharacteristic> _subscribed = new List<GattCharacteristic>();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private Timer _summaryTimer;
        private StreamWriter _csv;
        private bool _disposed;

        // Byte stream reassembled in arrival order, kept from the last header seen onwards.
        private readonly List<byte> _stream = new List<byte>(4 * PackageBytes);
        private DateTimeOffset _lastWindowsTimestamp;
        private long _lastArrivalTicks = -1;
        private bool _anyNotification;

        // Counters for the current summary window.
        private long _notifications, _bytes, _outOfOrder, _headers, _intact, _broken, _maxSilenceTicks;
        private int _minLen = int.MaxValue, _maxLen;
        private readonly HashSet<char> _characteristicsSeen = new HashSet<char>();
        private SdkPackageStats _sdkAtWindowStart;
        private long _windowStartTicks;

        // Totals for the whole connection.
        private long _totalSeconds, _totalHeaders, _totalIntact, _totalSdkAccepted;

        public BleNotificationTrace(Action<string> log, Func<SdkPackageStats> sdkStats)
        {
            _log = log ?? (_ => { });
            _sdkStats = sdkStats ?? (() => default(SdkPackageStats));
        }

        public async Task StartAsync(BluetoothLEDevice device)
        {
            try
            {
                var services = await device.GetGattServicesAsync(BluetoothCacheMode.Cached);
                if (services.Status != GattCommunicationStatus.Success)
                {
                    _log($"[ble-trace] could not read the band's services ({services.Status}) — trace off.");
                    return;
                }
                foreach (var service in services.Services)
                {
                    var chars = await service.GetCharacteristicsAsync(BluetoothCacheMode.Cached);
                    if (chars.Status != GattCommunicationStatus.Success) continue;
                    foreach (var c in chars.Characteristics)
                    {
                        if (!DataCharacteristics.Contains(c.Uuid)) continue;
                        if ((c.CharacteristicProperties & GattCharacteristicProperties.Notify) == 0) continue;
                        c.ValueChanged += OnValueChanged;
                        lock (_gate) _subscribed.Add(c);
                    }
                }
                int count;
                lock (_gate) count = _subscribed.Count;
                if (count == 0)
                {
                    _log("[ble-trace] the band's EEG characteristics were not found — trace off.");
                    return;
                }

                OpenCsv();
                lock (_gate)
                {
                    _windowStartTicks = _clock.ElapsedTicks;
                    _sdkAtWindowStart = _sdkStats();
                    if (!_disposed) _summaryTimer = new Timer(_ => Summarise(), null, SummaryIntervalMs, SummaryIntervalMs);
                }
                _log($"[ble-trace] ON — watching {count} EEG characteristic(s); a summary follows every " +
                     $"{SummaryIntervalMs / 1000} s{(_csv != null ? ", raw notifications go to the CSV in the logs folder" : "")}.");

                await Task.Delay(3000);
                await EnsureNotificationsReachUs();
            }
            catch (Exception ex)
            {
                _log("[ble-trace] unavailable (" + ex.Message + ") — recording is unaffected.");
            }
        }

        // Windows normally delivers notifications to every handler in the app once the SDK has
        // subscribed. If ours stay silent while the SDK is receiving, re-assert Notify.
        private async Task EnsureNotificationsReachUs()
        {
            bool seen;
            List<GattCharacteristic> chars;
            lock (_gate) { seen = _anyNotification; chars = _subscribed.ToList(); }
            if (seen || _sdkStats().Accepted == 0) return;
            foreach (var c in chars)
            {
                try
                {
                    var status = await c.WriteClientCharacteristicConfigurationDescriptorAsync(
                        GattClientCharacteristicConfigurationDescriptorValue.Notify);
                    if (status != GattCommunicationStatus.Success)
                        _log($"[ble-trace] subscribing to {c.Uuid} returned {status}.");
                }
                catch (Exception ex) { _log($"[ble-trace] subscribing to {c.Uuid} failed: {ex.Message}"); }
            }
            _log("[ble-trace] no notifications reached the trace yet — re-subscribed (Notify).");
        }

        private void OnValueChanged(GattCharacteristic sender, GattValueChangedEventArgs args)
        {
            try
            {
                byte[] data = ToArray(args.CharacteristicValue);
                long now = _clock.ElapsedTicks;
                char ch = sender.Uuid.ToString().Last();
                lock (_gate)
                {
                    if (_disposed) return;
                    bool outOfOrder = _anyNotification && args.Timestamp < _lastWindowsTimestamp;
                    if (outOfOrder) _outOfOrder++;
                    else _lastWindowsTimestamp = args.Timestamp;
                    _anyNotification = true;
                    if (_lastArrivalTicks >= 0) _maxSilenceTicks = Math.Max(_maxSilenceTicks, now - _lastArrivalTicks);
                    _lastArrivalTicks = now;

                    _notifications++;
                    _bytes += data.Length;
                    _minLen = Math.Min(_minLen, data.Length);
                    _maxLen = Math.Max(_maxLen, data.Length);
                    _characteristicsSeen.Add(ch);
                    Assemble(data);

                    _csv?.WriteLine(string.Join(",",
                        (now * 1000.0 / Stopwatch.Frequency).ToString("F3", System.Globalization.CultureInfo.InvariantCulture),
                        args.Timestamp.UtcDateTime.ToString("HH:mm:ss.fffffff"),
                        ch, data.Length, outOfOrder ? 1 : 0, ToHex(data)));
                }
            }
            catch { /* diagnostics only — never let the trace throw into the BLE stack */ }
        }

        // Finds package headers in the arrival-order byte stream. Two headers exactly 645 bytes apart
        // enclose an intact package; any other distance means bytes went missing between them.
        private void Assemble(byte[] data)
        {
            _stream.AddRange(data);
            int nextScan = _scanFrom;
            for (int i = _scanFrom; i + Signature.Length <= _stream.Count; i++)
            {
                if (!IsSignatureAt(i)) continue;
                int start = i - 1;   // the signature sits at header bytes 1-7
                _headers++;
                if (_lastHeader >= 0)
                {
                    if (start - _lastHeader == PackageBytes) _intact++;
                    else _broken++;
                }
                _lastHeader = start;
                i += Signature.Length - 1;
                nextScan = i + 1;
            }
            // A signature can straddle two notifications, so the last few bytes are scanned again
            // next time — but never a signature already counted.
            _scanFrom = Math.Max(Math.Max(nextScan, _stream.Count - Signature.Length + 1), 1);

            // Keep from the last header on (the next header completes or breaks it); without one,
            // just the tail a straddling signature could start in.
            int keepFrom = _lastHeader >= 0 ? _lastHeader : Math.Max(0, _stream.Count - Signature.Length - 1);
            if (keepFrom > 0)
            {
                _stream.RemoveRange(0, keepFrom);
                _scanFrom = Math.Max(1, _scanFrom - keepFrom);
                if (_lastHeader >= 0) _lastHeader -= keepFrom;
            }
        }

        private int _scanFrom = 1;
        private int _lastHeader = -1;

        private bool IsSignatureAt(int i)
        {
            for (int j = 0; j < Signature.Length; j++)
                if (_stream[i + j] != Signature[j]) return false;
            return true;
        }

        private void Summarise()
        {
            string line;
            lock (_gate)
            {
                if (_disposed) return;
                long now = _clock.ElapsedTicks;
                double seconds = (now - _windowStartTicks) / (double)Stopwatch.Frequency;
                var sdk = _sdkStats();
                long sdkAccepted = sdk.Accepted - _sdkAtWindowStart.Accepted;
                long sdkLosses = sdk.AcceptedAfterLoss - _sdkAtWindowStart.AcceptedAfterLoss;
                long expected = (long)Math.Round(seconds * PackagesPerSecond);
                double bytePct = 100.0 * _bytes / (seconds * PackagesPerSecond * PackageBytes);

                var verdict = new List<string>();
                long neverArrived = expected - _headers;
                if (neverArrived > 1) verdict.Add($"{neverArrived} package(s) never reached the PC (radio or band)");
                if (_broken > 0) verdict.Add($"{_broken} arrived with bytes missing (radio or band)");
                if (_intact > sdkAccepted + 1) verdict.Add($"the SDK dropped {_intact - sdkAccepted} intact package(s) (software)");
                if (_outOfOrder > 0) verdict.Add($"{_outOfOrder} notification(s) arrived out of order");
                string tail = verdict.Count == 0 ? "clean" : string.Join("; ", verdict);

                line = $"[ble-trace] last {seconds:F0} s: {_notifications} notifications on {_characteristicsSeen.Count} characteristic(s) " +
                       $"({(_notifications > 0 ? _minLen : 0)}–{_maxLen} B), {_bytes:N0} B = {bytePct:F0}% of what the band sends; " +
                       $"band packages {_headers} seen of ~{expected}, {_intact} intact, {_broken} broken; " +
                       $"SDK accepted {sdkAccepted}, {sdkLosses} loss event(s); longest silence " +
                       $"{_maxSilenceTicks * 1000 / Stopwatch.Frequency} ms → {tail}.";

                _totalSeconds += (long)Math.Round(seconds);
                _totalHeaders += _headers;
                _totalIntact += _intact;
                _totalSdkAccepted += sdkAccepted;

                _notifications = _bytes = _outOfOrder = _headers = _intact = _broken = _maxSilenceTicks = 0;
                _minLen = int.MaxValue; _maxLen = 0;
                _characteristicsSeen.Clear();
                _windowStartTicks = now;
                _sdkAtWindowStart = sdk;
                try { _csv?.Flush(); } catch { /* ignore */ }
            }
            _log(line);
        }

        private void OpenCsv()
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                          "NeuuroBridge", "logs");
                Directory.CreateDirectory(dir);
                string path = Path.Combine(dir, $"ble_trace_{DateTime.Now:yyyyMMdd_HHmmss}.csv");
                var w = new StreamWriter(path, append: false);
                w.WriteLine("t_ms,windows_timestamp_utc,characteristic,length,out_of_order,hex");
                lock (_gate) _csv = w;
            }
            catch (Exception ex) { _log("[ble-trace] CSV unavailable: " + ex.Message); }
        }

        public void Dispose()
        {
            List<GattCharacteristic> chars;
            Timer timer;
            StreamWriter csv;
            long seconds, headers, intact, sdkAccepted;
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                chars = _subscribed.ToList(); _subscribed.Clear();
                timer = _summaryTimer; _summaryTimer = null;
                csv = _csv; _csv = null;
                seconds = _totalSeconds; headers = _totalHeaders; intact = _totalIntact; sdkAccepted = _totalSdkAccepted;
            }
            try { timer?.Dispose(); } catch { /* ignore */ }
            // Only our handlers come off. The subscription itself is left alone: it belongs to the SDK.
            foreach (var c in chars) { try { c.ValueChanged -= OnValueChanged; } catch { /* ignore */ } }
            try { csv?.Dispose(); } catch { /* ignore */ }
            if (seconds > 0)
                _log($"[ble-trace] OFF — over {seconds} s: {headers} band packages seen of ~{(long)(seconds * PackagesPerSecond)}, " +
                     $"{intact} intact, SDK accepted {sdkAccepted}.");
        }

        private static byte[] ToArray(IBuffer buffer)
        {
            var bytes = new byte[buffer.Length];
            using (var reader = DataReader.FromBuffer(buffer)) reader.ReadBytes(bytes);
            return bytes;
        }

        private static string ToHex(byte[] data)
        {
            var sb = new StringBuilder(data.Length * 2);
            foreach (var b in data) sb.Append(b.ToString("X2"));
            return sb.ToString();
        }
    }
}
