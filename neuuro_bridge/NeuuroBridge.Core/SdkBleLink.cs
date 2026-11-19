using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

namespace NeuuroBridge
{
    /// <summary>
    /// Reaches the band's GATT characteristics through the Neeuro SDK's OWN open connection.
    ///
    /// WHY: the SDK opens the band's UART service (6e400001) exclusively. A second handle from the
    /// bridge gets SharingViolation / AccessDenied (seen on every connect, 19 Nov 2026), so
    /// BandKeepAwake could never send Neeuro's disable-auto-off command and the band kept switching
    /// itself off ~5-10 minutes in. The SDK holds the characteristics we need, already open, in
    /// BLEDeviceServices.senzeband_connections[address].txCharacteristic / .deviceCharacteristic.
    ///
    /// HOW: reflection into SDK internals (decompiled NeeuroOSWindows.BLEDeviceServices, the
    /// singleton from getDeviceServicesHandler()). The SDK's public SendCommand is NOT used: it is
    /// async void, so a failed write is unobservable and its exceptions land on the UI thread as
    /// unhandled (the KeyNotFoundException / 0x8000000E entries in crash.txt). Writing to its
    /// txCharacteristic ourselves keeps the await and the error in our hands.
    ///
    /// Tied to this SDK build's private names. If an SDK update renames them, every lookup here fails
    /// soft (returns null with a note for the log) and nothing else is affected.
    /// </summary>
    internal static class SdkBleLink
    {
        private const string ServicesType = "NeeuroOSWindows.BLEDeviceServices";

        /// <summary>The SDK's command (TX) characteristic and the data characteristics it listens on,
        /// for the band whose SDK address key is <paramref name="addressKey"/> (the decimal Bluetooth
        /// address, e.g. "227405302602318"). Null command when not found; <paramref name="note"/>
        /// says why.</summary>
        public static GattCharacteristic Find(string addressKey, out List<GattCharacteristic> data, out string note)
        {
            data = new List<GattCharacteristic>();
            try
            {
                var type = typeof(NeeuroOSWindows.SenzeBandConnectInterface).Assembly.GetType(ServicesType, throwOnError: false);
                if (type == null) { note = "SDK type BLEDeviceServices not found"; return null; }

                var services = type.GetMethod("getDeviceServicesHandler", BindingFlags.Public | BindingFlags.Static)
                                   ?.Invoke(null, null);
                if (services == null) { note = "SDK device services not created"; return null; }

                var table = type.GetField("senzeband_connections", BindingFlags.NonPublic | BindingFlags.Instance)
                                ?.GetValue(services) as IDictionary;
                if (table == null) { note = "SDK connection table not found"; return null; }

                object connection;
                lock (table.SyncRoot) connection = table.Contains(addressKey) ? table[addressKey] : null;
                if (connection == null) { note = $"no SDK connection for {addressKey} ({table.Count} known)"; return null; }

                var connType = connection.GetType();
                var tx = connType.GetField("txCharacteristic")?.GetValue(connection) as GattCharacteristic;
                if (connType.GetField("deviceCharacteristic")?.GetValue(connection) is IEnumerable list)
                    foreach (var c in list)
                        if (c is GattCharacteristic g) data.Add(g);

                note = tx == null ? "SDK connection has no TX characteristic yet" : $"SDK TX {tx.Uuid}";
                return tx;
            }
            catch (Exception ex)
            {
                note = "SDK lookup failed: " + (ex.InnerException ?? ex).Message;
                return null;
            }
        }
    }
}
