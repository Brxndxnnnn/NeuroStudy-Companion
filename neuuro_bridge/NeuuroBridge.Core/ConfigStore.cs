using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace NeuuroBridge
{
    /// <summary>
    /// The machine-wide, update-surviving config store written by first-run activation:
    /// <c>%ProgramData%\NeuuroBridge\bridge.env</c>. Velopack swaps the whole app folder
    /// on every update, so nothing durable may live next to the exe — this file is the
    /// one place clinic credentials exist. Same key=value format as a .env, except
    /// secret values are DPAPI-encrypted (machine scope) and prefixed <c>enc:</c>.
    /// </summary>
    public static class ConfigStore
    {
        private const string EncPrefix = "enc:";
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("NeuuroBridge.v1");

        public static string Directory =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NeuuroBridge");

        public static string FilePath => Path.Combine(Directory, "bridge.env");

        /// <summary>True once activation has written the store — i.e. this machine is enrolled.</summary>
        public static bool Exists => File.Exists(FilePath);

        /// <summary>Value for <paramref name="key"/> (decrypted if stored encrypted), or null.</summary>
        public static string Read(string key)
        {
            if (!Exists) return null;
            try
            {
                foreach (var raw in File.ReadAllLines(FilePath))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    if (!string.Equals(line.Substring(0, eq).Trim(), key, StringComparison.OrdinalIgnoreCase)) continue;
                    return Decode(line.Substring(eq + 1).Trim());
                }
            }
            catch (Exception)
            {
                // Unreadable/corrupt store must never take the bridge down; callers fall
                // back to the dev .env walk and the UI surfaces missing config naturally.
            }
            return null;
        }

        /// <summary>
        /// Atomically writes the whole store. Keys listed in <paramref name="secretKeys"/>
        /// are DPAPI-encrypted (machine scope) so a copied file is useless off this machine.
        /// </summary>
        public static void Write(IDictionary<string, string> values, ISet<string> secretKeys)
        {
            System.IO.Directory.CreateDirectory(Directory);
            var sb = new StringBuilder();
            sb.AppendLine("# NeuuroBridge machine config — written by activation. Do not edit.");
            sb.AppendLine("# Delete this file and relaunch the bridge to re-activate this machine.");
            foreach (var kv in values)
            {
                if (kv.Value == null) continue;
                var value = secretKeys != null && secretKeys.Contains(kv.Key) ? Encrypt(kv.Value) : kv.Value;
                sb.Append(kv.Key).Append('=').AppendLine(value);
            }
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
            if (File.Exists(FilePath)) File.Delete(FilePath);
            File.Move(tmp, FilePath);
        }

        /// <summary>Removes the store — the next launch shows the activation dialog again.</summary>
        public static void Reset()
        {
            if (Exists) File.Delete(FilePath);
        }

        private static string Encrypt(string plain)
        {
            var cipher = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(plain), Entropy, DataProtectionScope.LocalMachine);
            return EncPrefix + Convert.ToBase64String(cipher);
        }

        private static string Decode(string stored)
        {
            if (!stored.StartsWith(EncPrefix, StringComparison.Ordinal)) return stored;
            var cipher = Convert.FromBase64String(stored.Substring(EncPrefix.Length));
            var plain = ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(plain);
        }
    }
}
