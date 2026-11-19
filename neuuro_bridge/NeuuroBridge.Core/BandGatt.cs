using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

namespace NeuuroBridge
{
    /// <summary>
    /// Finds the SenzeBand's GATT characteristics through the bridge's OWN handle to the band (the
    /// vendor SDK keeps its handle to itself). Used by the Bluetooth trace and keep-awake.
    ///
    /// Both used to ask Windows once, from its cache, and silently skip any service whose
    /// characteristics came back with an error. On the band tested on 19 Nov 2026 that found
    /// nothing at all, every connection ("characteristics were not found"), with no hint why. This
    /// version asks the cache first and then the band itself, opens each service for shared use
    /// (the SDK already has it open), and logs what Windows answered at each step so a failure
    /// can be diagnosed from the log.
    /// </summary>
    internal static class BandGatt
    {
        public static async Task<List<GattCharacteristic>> FindAsync(
            BluetoothLEDevice device, ICollection<Guid> wanted, Action<string> log, string tag)
        {
            var found = new List<GattCharacteristic>();
            var notes = new List<string>();

            IReadOnlyList<GattDeviceService> services = null;
            foreach (var mode in new[] { BluetoothCacheMode.Cached, BluetoothCacheMode.Uncached })
            {
                GattDeviceServicesResult result;
                try { result = await device.GetGattServicesAsync(mode); }
                catch (Exception ex) { notes.Add($"services ({mode}): {ex.Message}"); continue; }
                notes.Add($"services ({mode}): {result.Status}, {result.Services?.Count ?? 0}");
                if (result.Status == GattCommunicationStatus.Success && result.Services.Count > 0)
                {
                    services = result.Services;
                    break;
                }
            }

            if (services != null)
            {
                foreach (var service in services)
                {
                    string sid = Short(service.Uuid);
                    try
                    {
                        // The SDK already has the service open; ask for shared access alongside it.
                        var open = await service.OpenAsync(GattSharingMode.SharedReadAndWrite);
                        if (open != GattOpenStatus.Success && open != GattOpenStatus.AlreadyOpened)
                            notes.Add($"{sid} open: {open}");
                    }
                    catch (Exception ex) { notes.Add($"{sid} open: {ex.Message}"); }

                    foreach (var mode in new[] { BluetoothCacheMode.Cached, BluetoothCacheMode.Uncached })
                    {
                        GattCharacteristicsResult chars;
                        try { chars = await service.GetCharacteristicsAsync(mode); }
                        catch (Exception ex) { notes.Add($"{sid} chars ({mode}): {ex.Message}"); continue; }
                        if (chars.Status != GattCommunicationStatus.Success)
                        {
                            notes.Add($"{sid} chars ({mode}): {chars.Status}");
                            continue;
                        }
                        var matches = chars.Characteristics.Where(c => wanted.Contains(c.Uuid)).ToList();
                        if (chars.Characteristics.Count > 0)
                        {
                            found.AddRange(matches);
                            break;
                        }
                        notes.Add($"{sid} chars ({mode}): none");
                    }
                }
            }

            if (found.Count == 0)
                log($"[{tag}] characteristic lookup: " + string.Join("; ", notes) + ".");
            return found;
        }

        private static string Short(Guid g) => g.ToString().Substring(0, 8);
    }
}
