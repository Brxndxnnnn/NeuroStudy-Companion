using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace NeuuroBridge
{
    /// <summary>
    /// Stops the SenzeBand from switching itself off ~10 minutes into a session.
    ///
    /// WHY
    /// ---
    /// Every recording longer than ~10 minutes lost its tail: the band powers down 9.6–12.4 min after
    /// the Bluetooth connection, even while streaming. Neeuro (10 Nov 2026) explained the rule: with
    /// the SDK connected, the band switches off after 10 minutes only when the PPG sensor is off (no
    /// red light) AND its motion sensor sees no head or body movement. A client sitting still in
    /// front of the image task is exactly that case. The timer starts at the Bluetooth connection.
    ///
    /// Neeuro's fix is a command that turns the auto-power-off feature off: 434D44FE0100FBED. It is
    /// not in the SDK (the SDK's own "disableSleepCommand", F7 01 FF, is answered with the firmware
    /// version and changes nothing on firmware 1.0.3.0). Packet layout as every SDK command: "CMD"
    /// + command FE + length 01 + payload 00 + CRC-16/XMODEM (FBED, verified).
    ///
    /// Optional fallback (env key KEEP_AWAKE_PPG=true): also switch the PPG sensor on with the SDK's
    /// own ppgOnCommand. Per Neeuro's table that alone keeps the band on. Off by default because
    /// PPG adds packets to the same Bluetooth link the EEG needs.
    ///
    /// HOW
    /// ---
    /// The SDK opens the band's UART service exclusively, so a second handle from the bridge is
    /// refused (SharingViolation / AccessDenied) and the command never went out before 19 Nov 2026.
    /// It is now written to the SDK's own, already-open command characteristic, found by reflection
    /// (see <see cref="SdkBleLink"/>), with the result checked; the band's notifications are watched
    /// for a few seconds for the "ACK" + FE reply. The SDK's SendCommand is not used: it is async
    /// void, so it cannot report a failed write and its exceptions surface on the UI thread. If the
    /// SDK lookup fails, a second handle is still tried (works on bands whose service isn't held
    /// exclusively). Sent on every connect and reconnect: whether the band keeps the setting across
    /// a reconnect is unknown.
    ///
    /// Everything is best-effort and logged; a failure here must never affect a recording.
    /// Env key DISABLE_AUTO_OFF=false turns the whole thing off.
    /// </summary>
    public static class BandKeepAwake
    {
        // From Neeuro's tech team, 10 Nov 2026.
        internal static readonly byte[] DisableAutoOffCommand = Hex("434D44FE0100FBED");
        // BLEDeviceServices.ppgOnCommand in the SDK.
        internal static readonly byte[] PpgOnCommand = Hex("434D44F90201019819");

        // "ACK" + command byte: how the band answers a command (e.g. 41434BF2 for start).
        private static readonly byte[] AckFe = { 0x41, 0x43, 0x4B, 0xFE };

        // The band's command (TX) characteristic: the classic one, or the BT5 UART one.
        private static readonly Guid[] CommandCharacteristics =
        {
            Guid.Parse("d44bc439-abfd-45a2-b575-925416129600"),
            Guid.Parse("6e400002-b5a3-f393-e0a9-e50e24dcca9e"),
        };

        // Where its replies arrive: the data characteristics the SDK subscribes to.
        private static readonly Guid[] ReplyCharacteristics =
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

        private const int SettleMs = 1500;     // let the SDK finish its own connect-time writes first
        private const int MaxWriteAttempts = 3;
        private const int RetryDelayMs = 1000;
        private const int AckWaitMs = 5000;

        public static bool Enabled =>
            !string.Equals(EnvConfig.FindDotEnvValue("DISABLE_AUTO_OFF")?.Trim(), "false", StringComparison.OrdinalIgnoreCase);

        private static bool PpgFallback =>
            string.Equals(EnvConfig.FindDotEnvValue("KEEP_AWAKE_PPG")?.Trim(), "true", StringComparison.OrdinalIgnoreCase);

        // Serialises runs: a quick reconnect must not interleave with the previous connection's run.
        private static readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);

        /// <summary>
        /// Fire-and-forget: sends the disable-auto-off command to the connected band, off-thread.
        /// <paramref name="addressCandidates"/> are the SDK's identifiers for the band, best first
        /// (see BleConnectionTuner.RequestThroughputAsync).
        /// </summary>
        public static void SendAsync(Action<string> log, params string[] addressCandidates)
        {
            log = log ?? (_ => { });
            if (!Enabled)
            {
                log("[keep-awake] DISABLE_AUTO_OFF=false — the band's 10-minute auto power-off is left on.");
                return;
            }
            var keys = (addressCandidates ?? new string[0]).Where(k => !string.IsNullOrWhiteSpace(k)).ToArray();
            foreach (var candidate in keys)
            {
                if (BleConnectionTuner.TryParseBluetoothAddress(candidate, out ulong address))
                {
                    Task.Run(() => Run(address, keys, log));
                    return;
                }
            }
            log("[keep-awake] no usable device address — could not switch off the band's auto power-off.");
        }

        private static async Task Run(ulong address, string[] sdkKeys, Action<string> log)
        {
            await Gate.WaitAsync().ConfigureAwait(false);
            BluetoothLEDevice device = null;   // only when we open our own handle; the SDK's is never disposed here
            try
            {
                await Task.Delay(SettleMs).ConfigureAwait(false);

                // 1) The SDK's own open connection.
                GattCharacteristic command = null;
                var replies = new List<GattCharacteristic>();
                var notes = new List<string>();
                foreach (var key in sdkKeys.Concat(new[] { address.ToString() }).Distinct())
                {
                    command = SdkBleLink.Find(key, out var data, out string note);
                    notes.Add(note);
                    if (command == null) continue;
                    replies = data.Where(c => (c.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0).ToList();
                    log($"[keep-awake] using the SDK's open connection ({note}, {replies.Count} reply channel(s)).");
                    break;
                }

                // 2) Fallback: our own handle (refused on bands whose UART service the SDK holds).
                if (command == null)
                {
                    log("[keep-awake] SDK connection not usable (" + string.Join("; ", notes) + ") — trying a separate handle.");
                    device = await BluetoothLEDevice.FromBluetoothAddressAsync(address);
                    if (device == null)
                    {
                        log("[keep-awake] Windows returned no device for the band — auto power-off left on.");
                        return;
                    }
                    (command, replies) = await FindCharacteristics(device, log).ConfigureAwait(false);
                    if (command == null)
                    {
                        log("[keep-awake] the band's command characteristic was not found — auto power-off left on.");
                        return;
                    }
                }

                // Watch for the reply before writing, so a fast answer is not missed.
                var ack = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs> onValue = (c, e) =>
                {
                    try
                    {
                        var bytes = ReadBytes(e.CharacteristicValue);
                        int at = IndexOf(bytes, AckFe);
                        if (at >= 0) ack.TrySetResult(ToHex(bytes, at, Math.Min(8, bytes.Length - at)));
                    }
                    catch { /* diagnostics only */ }
                };
                foreach (var r in replies) r.ValueChanged += onValue;
                try
                {
                    var status = await Write(command, DisableAutoOffCommand, log, "disable auto power-off").ConfigureAwait(false);
                    if (status == GattCommunicationStatus.Success)
                    {
                        var done = await Task.WhenAny(ack.Task, Task.Delay(AckWaitMs)).ConfigureAwait(false);
                        log(done == ack.Task
                            ? $"[keep-awake] band acknowledged: {ack.Task.Result}. Auto power-off should now be off for this connection."
                            : $"[keep-awake] command written, but no reply seen within {AckWaitMs / 1000} s. " +
                              "A session running past 10 minutes will show whether it took effect.");
                    }
                }
                finally
                {
                    foreach (var r in replies) { try { r.ValueChanged -= onValue; } catch { /* ignore */ } }
                }

                if (PpgFallback)
                {
                    var ppg = await Write(command, PpgOnCommand, log, "PPG on").ConfigureAwait(false);
                    if (ppg == GattCommunicationStatus.Success)
                        log("[keep-awake] KEEP_AWAKE_PPG=true — PPG switched on (the band's red light should be lit).");
                }
            }
            catch (Exception ex)
            {
                log("[keep-awake] could not switch off the band's auto power-off (" + ex.Message + "). " +
                    "Sessions may stop about 10 minutes after connecting.");
            }
            finally
            {
                try { device?.Dispose(); } catch { /* ignore */ }
                Gate.Release();
            }
        }

        private static async Task<(GattCharacteristic command, List<GattCharacteristic> replies)> FindCharacteristics(
            BluetoothLEDevice device, Action<string> log)
        {
            GattCharacteristic command = null;
            var replies = new List<GattCharacteristic>();
            var wanted = CommandCharacteristics.Concat(ReplyCharacteristics).ToList();
            foreach (var c in await BandGatt.FindAsync(device, wanted, log, "keep-awake").ConfigureAwait(false))
            {
                if (command == null && CommandCharacteristics.Contains(c.Uuid)) command = c;
                else if (ReplyCharacteristics.Contains(c.Uuid)
                         && (c.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0)
                    replies.Add(c);
            }
            return (command, replies);
        }

        private static async Task<GattCommunicationStatus> Write(
            GattCharacteristic characteristic, byte[] packet, Action<string> log, string what)
        {
            var status = GattCommunicationStatus.Unreachable;
            for (int attempt = 1; attempt <= MaxWriteAttempts; attempt++)
            {
                try
                {
                    var writer = new DataWriter();
                    writer.WriteBytes(packet);
                    status = await characteristic.WriteValueAsync(writer.DetachBuffer());
                }
                catch (Exception ex)
                {
                    log($"[keep-awake] {what} write attempt {attempt} failed: {ex.Message}");
                    status = GattCommunicationStatus.Unreachable;
                }
                if (status == GattCommunicationStatus.Success)
                {
                    log($"[keep-awake] sent {what} ({ToHex(packet, 0, packet.Length)}).");
                    return status;
                }
                if (attempt < MaxWriteAttempts) await Task.Delay(RetryDelayMs).ConfigureAwait(false);
            }
            log($"[keep-awake] {what} was not accepted by the band ({status}) after {MaxWriteAttempts} attempts.");
            return status;
        }

        private static byte[] ReadBytes(IBuffer buffer)
        {
            var bytes = new byte[buffer.Length];
            using (var reader = DataReader.FromBuffer(buffer)) reader.ReadBytes(bytes);
            return bytes;
        }

        internal static int IndexOf(byte[] haystack, byte[] needle)
        {
            for (int i = 0; i + needle.Length <= haystack.Length; i++)
            {
                int j = 0;
                while (j < needle.Length && haystack[i + j] == needle[j]) j++;
                if (j == needle.Length) return i;
            }
            return -1;
        }

        internal static byte[] Hex(string hex)
        {
            var bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return bytes;
        }

        private static string ToHex(byte[] bytes, int start, int count)
        {
            var sb = new StringBuilder(count * 2);
            for (int i = start; i < start + count; i++) sb.Append(bytes[i].ToString("X2"));
            return sb.ToString();
        }
    }
}
